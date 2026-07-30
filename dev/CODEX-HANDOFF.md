# Codex project handoff

Last updated: 2026-07-29.

This is the authoritative starting point when opening `D:\projects\PacketAgent`
as a new project in the Codex app.

## Open this project

- Project folder: `D:\projects\PacketAgent`
- Active local branch: `codex/packetagent-foundation`, tracking `origin/main`
- Historical source remote: `taskloom-source`
- PacketAgent `origin`: `git@github.com:packetloss404/PacketAgent.git`
- Primary remote branch: `main`
- Original TaskLoom checkout: `D:\projects\taskloom`, preserved and unchanged

Do not push PacketAgent changes to `taskloom-source`. PacketAgent commits belong
on `origin/main`.

The repository-wide rename, compatibility migration, documentation reset,
carried Builder layout fix, and rename-sensitive test corrections are preserved
in foundation commit `d60cd47`. W1-W10's local gates are implemented as
isolated changes on this branch. Do not reset this branch to the historical
source remote.

## Product decision

PacketAgent is the self-hosted, always-available runtime for autonomous
workers in the Packet suite.

- PacketADE plans, builds, and supervises development work.
- PacketCode is the terminal coding environment.
- PacketChat is the conversational surface.
- PacketPhone is the remote approval surface.
- PacketAgent keeps approved workers running after the originating app closes.

"Always on" means the control plane remains available. Worker runs are
event-driven and bounded by time, cost, iterations, failures, permissions,
and explicit exit conditions.

The inherited Builder stays. Its new role is the worker-authoring studio.
Prompt-to-app generation remains a supported secondary capability.

## Completed foundation

- Cloned the full TaskLoom history into the independent PacketAgent folder.
- Confirmed every committed TaskLoom branch and worktree was already an
  ancestor of source `main`.
- Carried the sole uncommitted TaskLoom Builder viewport/grid fix.
- Renamed product, package, source identifiers, UI, events, configuration,
  Docker resources, documentation, and default data files.
- Renamed the old store/service modules to `packetagent-*`.
- Added `src/brand.ts` and tests for temporary `TASKLOOM_*` environment aliases
  and non-destructive legacy default-data copying.
- Reframed the roadmap and backlog around the W1-W10 autonomous-worker loops.
- Defined the future PacketADE deployment package and event contract.
- Completed W1's storage-neutral canonical Worker schemas, runtime validators,
  lifecycle guards, immutable-version checks, and legacy read projections.
- Completed W2's JSON, SQLite, and managed-Postgres Worker persistence,
  immutable lifecycle commands, private RBAC routes, durable command receipts,
  event journal, rollback links, and backend parity gate.
- Completed W3's versioned activation envelope, durable delivery inbox,
  encrypted expiring payload references, atomic queued-run/job admission,
  W3C traces, and manual/cron/webhook/alert/queue adapters.
- Completed W4's port-isolated plan-act-evaluate-checkpoint-decide supervisor,
  bounded provider/tool execution, optimistic run revisions, renewable fenced
  leases, scheduler cancellation/shutdown handling, and adversarial gate.
- Completed W5's digest-chained full-state checkpoints, prepared/completed
  mutation effect receipts, exact-cursor restart recovery, corrupt/uncertain
  replay quarantine, startup reconciliation, and cross-backend crash gate.
- Completed W6.1's tool/verb/resource capability compiler, version-digest-bound
  deterministic policy, deployment grant narrowing, validation failures for
  unsafe resource syntax, and compiled-policy persistence integrity checks.
- Completed W6.2's typed operation descriptors for every production tool,
  pre-effect policy preflight, mandatory fail-closed `executeTool` enforcement,
  complete Worker tool context, and redacted allow/deny event recording.
- Completed W6.3's encrypted workspace-scoped opaque credentials,
  policy-before-secret resolution, public A/AAAA and pinned connected-address
  validation, redirect denial, fail-closed external adapters, scrubbed process
  environments, and Docker-only no-network Worker command execution.
- Completed W6.4's durable workspace/deployment rolling windows, atomic
  provider-cost and billable-action reservations, actual-cost settlement,
  retry/fence idempotency, and lease-expiry release reconciliation.
- Completed W6.5's production-catalog executor/direct-access matrix and added
  one-shot tool-bound registry permits that fail closed before credentials,
  budgets, effects, handlers, or external I/O on denied Worker calls.
- Completed W7.1's version-bound attention, approval-grant, control-command,
  and notification-delivery records, including nonce digests, durable replay
  identities, graph integrity, workspace export, and storage parity.
- Completed W7.2's atomic, actor-bound, expected-revision and idempotency
  control service for pause, resume, stop, revoke, approve once, approve for
  run, and reject. Paused runs retain checkpoints and budgets while losing
  their lease; resumed runs queue exactly once per command; stop/revoke
  terminal state is observed safely by live supervisors.
- Completed W7.3's supervisor approval-attention flow. Approval-required
  operations atomically checkpoint the exact pending action, move the run to
  waiting, create bounded attention and initial notification references, and
  schedule deduplicated escalation and expiration work. Resume and final tool
  execution both require the exact version-, deployment-, policy-,
  capability-, operation-, action-, and expiry-bound grant; one-time grants
  replay only their original action and no raw approval nonce is persisted.
- Completed W7.4's independent Worker operator API. Workspace-scoped run and
  attention reads plus pause, resume, stop, deployment revoke, approve-once,
  approve-for-run, and reject are mounted beside the lifecycle API, not under
  Builder. Inspect, run-control, deployment-control, and approval permissions
  are distinct; mutation bodies are allowlisted and revision/idempotency bound;
  projections omit raw run/event/control internals; and a first-use approval
  nonce is returned with no-store headers and never appears on replay.
- Completed W7.5's restart and kill gate. Fresh processes resume only the exact
  approved action, callback replay creates no additional nonce or grant,
  approve/reject and activation/revoke races are deterministic in both
  orderings, durable stop is observed at every supervisor phase with no later
  action, and operator routes reconstructed from durable state can stop runs
  and revoke deployments without an authoring service.
- Completed W8.1's event and evidence contract. New Worker journal writes use
  digest-bound v2 envelopes with monotonic workspace, deployment, and run
  sequences and atomically paired evidence entries. Activation, queue,
  supervisor, provider, tool/effect, approval, checkpoint, control, recovery,
  and terminal sources carry W3C trace and durable record correlations.
  Opaque raw-payload references remain separate; provenance-bound artifact
  manifests require content digests. V1 events remain readable, and migration
  `0022` persists indexed event/evidence/artifact records in SQLite.
- Completed W8.2's deterministic rollups. A pure cumulative reducer rebuilds
  immutable version, deployment, and run views for provider/tool/effect calls,
  retries and queue time, approvals, checkpoints, current and rolling budgets,
  artifacts, outcomes, and exit-predicate matches. Reordered sources and fresh
  processes return the same view, and missing retained sources are explicit
  typed gaps rather than zeroed or fabricated data.
- Completed W8.3's bounded retention and redaction. Separate metadata, summary,
  prompt, tool-payload, and artifact windows drive read-only dry runs or
  item/time-bounded workspace cleanup jobs. The journal sanitizes sensitive
  keys and supplied known values before hashing, and observability reads apply
  a second boundary pass. Only terminal-run payload state is compacted;
  duplicate-effect metadata remains durable. Digest-only deletion events make
  retention gaps explainable, while artifact bytes require an injected
  digest-checked deletion port rather than arbitrary path removal.
- Completed W8.4's canonical operations API and UI. One independently
  authorized, workspace-scoped read model joins immutable Worker identity,
  deterministic rollups, budget policy and usage, checkpoint metadata,
  attention, evidence, artifacts, and allowed controls. Stable opaque cursors
  bind workspace and filters; bounded SSE resumes from `Last-Event-ID` with
  polling fallback. `/runs` is the canonical Worker workbench and `/activity`
  preserves inherited Agent activity.
- Completed W8.5's answerability gate. One-read projections answer what is
  running, why, from which immutable version/deployment, against which hard
  budgets, at which checkpoint, with what attention/evidence/artifacts and
  terminal result. Tests cover source-order replay, redaction, retention gaps,
  filter/tenant-bound cursors, accessible loading/error/empty states, and
  JSON/SQLite/managed-Postgres parity. The screenshot/manual matrix is recorded
  in `dev/TESTING.md`.
- Completed W9.1's WorkerPackage v1 contract. The strict envelope maps
  PacketADE provenance and authored Worker data directly to W1 version content,
  carries digest-bound artifact descriptors and no secret values, and rejects
  undeclared fields or unknown major versions. Mandatory SHA-256 covers exact
  deterministic UTF-8 subject bytes. Optional DSSE envelopes must contain the
  same bytes and pass an injected trust-policy verifier when signatures are
  required. Checked v1 and unsupported-v2 fixtures are committed.
- Completed W9.2's Packet-product trust boundary. PacketADE bearer credentials
  are returned once and stored only as digests; each binds one workspace,
  service actor, allowed operation set, expiry/revocation state, and optional
  signature requirement. Package acceptance re-verifies schema, digest,
  provenance, and DSSE policy; requires an explicit local capability subset;
  compiles narrowed grants; and stores a durable idempotency receipt before any
  deployment. Accepted, rejected, denied, replayed, conflicting, and
  rate-limited writes are auditable without raw tokens. Migration `0023` and
  workspace export preserve JSON, SQLite, and managed-Postgres parity while
  omitting token digests from exports.
- Completed W9.3's PacketADE deployment endpoints. The Packet-product API
  validates without lifecycle writes; deploys, atomically updates, activates,
  inspects, lists runs, pauses, resumes, rolls back, and revokes through the
  W2/W3/W7/W8 services; returns field-addressed errors, local approval and
  capability decisions, plus resulting IDs; and binds every deployment to its
  accepted package receipt. Forward updates and rollbacks preserve locally
  narrowed grants. Migration `0024` and workspace export pass JSON, SQLite,
  and managed-Postgres parity.
- Completed R1's repository-health gate with clean typecheck, lint,
  formatting, production build, web tests, migration recovery, and API tests.
- Completed R2's canonical provider/model/policy catalog, native and
  conditional structured-response mapping, one bounded vLLM compatibility
  fallback, one non-executing malformed-tool correction, Gemini/OpenRouter
  vault parity, expanded provider-kind persistence, and secret-free
  workspace-aware readiness.
- Completed R6.1's default SMTP transport. Legacy Agent runs retain `SMTP_*`
  compatibility; autonomous Workers accept only a declared encrypted
  `smtp_config` reference after recipient policy approval. The sender is
  credential-bound, SMTP reuses W6 public-address validation and pinning, and
  implicit TLS or mandatory STARTTLS with certificate validation is required.
  The deterministic `npm run verify:smtp` gate sends no live email.
- Completed R6.2's LLM-authored AgentTemplate path. One bounded canonical
  provider call uses structured output where supported; local validation owns
  registered tools, trigger/schedule identity, safe typed inputs, redaction,
  and complete fallback. Drafts expose provider/model provenance or the exact
  deterministic fallback class. Approved Agents retain existing APIs and
  project as valid draft Worker versions without claiming R6.6 lifecycle
  consolidation.
- Completed R6.3's pre-run provider readiness. Agent authoring, readiness,
  saved exact model, and stable execution route use one canonical preset
  resolution. Drafts expose secret-free key-source metadata,
  configured-but-unverified model state, and explicit streaming, tool-use, and
  structured-output support. Missing runtimes fail closed; model-dependent
  capabilities remain visible for R6.4 evaluation.
- Completed R6.4's bounded Agent memory, saved typed input examples, and real
  first-run evaluation. Builder approval persists examples before readiness or
  tool-approval gates, then uses the bounded Agent loop. Versioned
  deterministic evidence records exact inputs, run/output/tool conditions,
  model identity, and operator-review notes without a second model judge call.
  JSON, SQLite, and managed Postgres plus Builder, Agent detail, and run traces
  preserve the evidence.

## Current implementation truth

Implemented substrate:

- storage-neutral canonical Worker domain records, validators, transition
  guards, content digests, version pinning, and draft legacy projections;
- durable Worker definitions, versions, deployments, runs, checkpoints,
  rollout links, command receipts, and lifecycle events in JSON, SQLite, and
  managed Postgres;
- private Worker lifecycle routes with viewer/member/admin boundaries,
  idempotent replay, stale-write conflicts, activation, pause/resume,
  retirement, and rollback;
- one durable activation path for manual, timezone-aware cron, opaque webhook,
  alert, and queue deliveries, with schema validation and exact-delivery
  deduplication;
- version-pinned queued Worker runs and execution jobs admitted atomically with
  their inbox record and audit event;
- canonical `worker.run` execution through narrow provider, tool, clock,
  checkpoint, event, lease, cancellation, and run ports;
- reducer-selected terminal outcomes with elapsed-time, iteration,
  provider-cost, failure, retry, and pre-execution tool-call bounds;
- optimistic run revisions, monotonic fenced leases, immutable full-memory
  checkpoint chains, revocation/cancellation checks, and shutdown-safe job
  release;
- startup and periodic expired-work recovery that resumes from the latest
  valid action cursor or quarantines corrupt and unsafe replay state;
- tool-boundary effect classification plus prepared/completed redacted
  receipts, deterministic effect keys, safe replay, and reconciliation hooks;
- validated-version capability compilation with a built-in tool verb/effect
  catalog, normalized resources, opaque vault references, immutable deployment
  grants, and deterministic compiled-policy digests;
- immediate Worker tool authorization against the pinned version/deployment
  policy, including normalized network, workspace, browser, GitHub, Slack,
  email, database, command, and working-directory targets;
- metadata-only workspace-scoped Worker credential records bound to immutable
  version references and resolved inside allowed handlers immediately before
  the external call;
- a hardened Worker network client with protocol, hostname, all-address,
  special-range, connected-address, redirect, timeout, and response-size
  enforcement;
- Docker-only Worker command execution with no network or host secrets,
  non-root/read-only containers, dropped capabilities, no-new-privileges, and
  CPU, memory, and PID limits;
- durable rolling-budget reservation records that atomically hold the
  maximum permitted provider charge or one externally billable action before
  execution, settle actual usage, and release abandoned holds once without
  double credit;
- one-shot executor permits on production registry handlers, preventing direct
  or nested Worker execution outside the immediate policy boundary;
- durable W7 control records binding attention, approval, command, and
  notification state to one immutable Worker run/version operation, with
  status-specific consumption/replay fields and no raw approval nonce;
- supervisor-created approval attention with immutable deadline disposition,
  exact pending-action checkpoints, initial and escalated notification
  references, one-time or run-scoped grant consumption, and an execution-time
  approval recheck;
- independently mounted Worker operator routes with explicit inspect,
  run-control, deployment-control, and approval permissions plus concise
  redacted run, attention, command, grant, and deployment projections;
- an adversarial restart/kill gate covering approval callback replay, competing
  controls, every supervisor phase, and headless operator independence;
- versioned digest-bound Worker events, atomically paired evidence, explicit
  source/trace correlations, opaque raw-payload references, provenance-bound
  artifact manifests, and ordered workspace-scoped observability reads;
- deterministic cumulative Worker version/deployment/run rollups over
  provider/tool/effect calls, retries, queue duration, approvals, checkpoints,
  budgets, artifacts, outcomes, and deduplicated missing-source gaps;
- separate Worker retention windows, central and read-boundary redaction,
  terminal-only payload compaction, digest-only deletion events,
  retention-explained gaps, and bounded workspace cleanup jobs;
- a consolidated Worker operations read model, cursor-paginated health,
  attention, event, evidence, and artifact APIs, bounded resumable SSE, and
  canonical Worker list/detail workbench;
- a strict WorkerPackage v1 contract with W1-aligned content/provenance,
  canonical SHA-256 verification, artifact descriptors, compatibility
  fixtures, and optional DSSE payload/signature verification;
- workspace-bound PacketADE service credentials, fixed `packet_product`
  actors and operations, local capability acceptance, durable pre-deployment
  package receipts, per-credential write limits, token-safe audit, and
  three-backend persistence/export parity;
- independently authenticated PacketADE validate/deploy/update/activate/
  inspect/list-runs/pause/resume/rollback/revoke routes, immutable
  package-to-deployment bindings, deterministic Worker IDs, atomic forward
  rollouts, W3 manual admission, and W7 revocation;
- versioned PacketADE deployment/run event pages and bounded SSE with stable
  cursor IDs, evidence links, explicit trace gaps, retention recovery, and
  durable idempotent ETag-guarded acknowledgements;
- a serialized PacketADE disconnect/restart handoff gate through fresh service
  reconstruction, evidence reconnect, update, pause/resume, rollback, and
  revoke, plus an opt-in real-network validation check;
- encrypted PacketChat route credentials, pinned-network delivery of bounded
  threaded Worker cards, replaceable progress summaries, and short-lived
  exact-binding read-only open/inspect callbacks;
- encrypted HTTPS-only PacketPhone route credentials, role-bounded approve,
  reject, pause, stop, and revoke controls, and durable single-use callbacks
  executed through W7;
- agent definitions and capped tool-use runs;
- schedules, webhooks, alerts, persistent jobs, retries, and dead-letter;
- six BYO model providers and local OpenAI-compatible/Ollama endpoints;
- canonical provider/model/capability and generation policy, workspace-vault
  keys for every hosted provider, structured-response mapping, one bounded
  malformed-tool correction, and secret-free readiness reporting;
- one bounded LLM AgentTemplate authoring path with deterministic
  trigger/schedule and registered-tool constraints, semantic validation,
  secret redaction, explicit heuristic fallback provenance, review-before-save,
  and valid legacy-Agent-to-Worker draft projection;
- one canonical Agent preset resolution shared by authoring, secret-free
  provider/model/key/capability readiness, the saved exact model, and a
  restart-safe provider route;
- bounded non-secret Agent memory, persisted typed input examples, expected
  output and required-tool contracts, and versioned deterministic first-run
  evaluation evidence through the real approval-bound Agent loop;
- tool approvals, encrypted secrets, RBAC, audit, sandbox, and Playwright;
- outbound HTTP, Slack, GitHub, TLS SMTP email, SQL, and scoped shell tool
  adapters;
- bounded app-code validation repair, per-app SQLite runtime, and supervised
  runtime workers;
- JSON, SQLite, and managed Postgres storage paths; and
- operational health, metrics, and provider cost records.

Not shipped:

- hardened Worker-specific browser and SQL drivers (those paths fail closed
  for Worker runs);
- canonical-only execution for legacy Agent records; legacy projections remain
  draft until R6.6 validation, migration, and API-compatibility gates pass;
- live PacketChat/PacketPhone interoperability certification when endpoint
  credentials are available.

Do not describe those missing Worker features as implemented.

## Exact resume point

Continue **R6.5 - signed, versioned Agent/Worker import and export** in
[`../BACKLOG.md#r6---agent-authoring-and-execution-depth`](../BACKLOG.md#r6---agent-authoring-and-execution-depth).
`BACKLOG.md` is the single ledger for every remaining R6-R8 task.
`worker-implementation-loops.md` provides execution mechanics but cannot add
active work absent from the backlog.

R1's first persistence slice is implemented: production managed Postgres pools
are reused per connection target and closed at server shutdown; migration and
restore candidates must pass SQLite integrity and foreign-key checks; corrupt
restore candidates leave the current database untouched; and managed backfill
preserves target-only records. The current re-audit evidence and remaining
open findings are in
[`r1-repository-health-audit.md`](r1-repository-health-audit.md).

The jobs audit is also closed: the redundant SQLite post-commit upsert was
removed, dedicated jobs remain inside the canonical store transaction, and all
find/update/cancel boundaries require the workspace identity. Cross-workspace
repository collisions and the historical claim/revert sequence have direct
regressions. The focused job/scheduler gate passes 91 tests.

The backend security/startup audit is also closed. `npm start` launches the
single-process server without watch mode; legacy migration and provider/tool
registration happen only inside explicit startup; restrictive workbench/API
security headers are active while generated-app previews retain a deliberate
CSP exception pending R5 origin isolation; and opt-in artifact reads require
an authenticated viewer whose workspace owns the exact legacy-agent or
canonical-Worker run ID in the URL. The focused startup/security gate passes
11 tests, typecheck passes, and the broader server/app/auth regression
selection passed 116 tests with one intentional sandbox skip.

The frontend finding slice is now implemented. A top-level generic recovery
boundary protects the app tree; the preview iframe has an accessible title and
explicit sandbox contract while full origin isolation remains R5; iteration
metadata redacts every secret literal rather than only the first; corrupt
activity-row handling was proven already fixed; audited inert controls are
removed, relabeled, or connected to live views; primary navigation, tabs, role
choices, output tabs, and project cards use native button semantics; and all
visible stale TaskLoom wordmarks now consume the PacketAgent web brand config.
The focused backend safety set passes 23 tests, the web gate passes 30 tests,
the production web build and typecheck pass, and a local signed-out/signed-in
browser pass is clean.

The persistence-authority and dependency-advisory slice is also complete.
[`persistence-authority.md`](persistence-authority.md) records JSON,
promoted/record-row SQLite, and advisory-lock-serialized managed-document
authority, staged cutovers, generated-app isolation, compatibility writers,
and the decision to retain the logical store facade. The README and deployment
guide no longer claim a live SQLite/Postgres dual-write or per-entity managed
runtime. Targeted non-major dependency upgrades removed every critical,
moderate, and low advisory. The remaining two high package entries represent
one React Router RSC advisory whose server-action path PacketAgent does not
use; [`r1-dependency-advisory-audit.md`](r1-dependency-advisory-audit.md)
records the reachability and exact-pin decision. Typecheck, production build,
30 web tests, and the full 1,525-test API gate pass.

R1 is complete. All 326 inherited Prettier files are formatted, ESLint is
clean, and all 123 native React buttons declare an explicit type. The full
closure gate passes typecheck, formatting, lint, production build, 30 web
tests, and 1,525 API tests (1,521 passed with 4 intentional live-probe skips).

R2 is complete. [`r2-provider-policy.md`](r2-provider-policy.md) records the
official research and implemented contract. A single catalog now drives
provider names, model defaults, capabilities, environment lookup, vault
eligibility, readiness, and hosted/local generation behavior. Provider
adapters map explicit workflow schemas to native or conditional structured
response transports; vLLM makes at most one prompt fallback after an
unsupported-field response. Malformed tool arguments never execute and receive
one correction turn. Gemini/OpenRouter keys now use the same encrypted
workspace-vault flow as the other hosted providers, including JSON, SQLite, and
managed-Postgres boundaries. The full closure gate passes typecheck, formatting,
lint, production build, 30 web tests, and 1,552 API tests (1,548 passed with 4
intentional live-probe skips).

R3.1 is complete. Generated-app validation failures are classified into
deterministic module-graph, type-contract, JSX, entry/config, styling, runtime
API, or generic families. Repair prompts prioritize the files with the most
diagnostics, cap diagnostic and source bytes, strip terminal control
sequences, give family-specific instructions, and retain the existing
two-repair/repeated-signature stop bounds.

R3.2 is complete. Legacy template, structured-draft, and historical
source-less checkpoints reuse their persisted deterministic source bundle
through an explicit path-normalizing, case-collision-rejecting conversion seam.
Model-backed iteration consumes that tree when ready; deterministic fallback
still returns a reviewed full tree, and applying it persists the next
checkpoint as `llm-filetree`. The legacy generation kill switch remains an
explicit opt-out.

R3.3 is complete. New-draft and iteration authoring emit typed, attempt-aware
per-file plan, write, and validation events through their SSE routes. The
Builder Source view renders the live tree during initial generation and
iteration, preserves repair-pass identity, and distinguishes failed,
completed, queued, and sandbox-skipped validation without overstating the
quality gate. Progress callbacks are observational and cannot break
generation. Focused backend/UI coverage passes 69 backend tests (68 passed,
one intentional Windows sandbox skip) and two UI tests.

R3.4 is complete. File-tree iteration responses carry a separate, sorted
added/modified/deleted/unchanged review with before/after SHA-256 and byte-size
evidence, while the apply list remains changes-only. The Source view can
filter all, changed, and unchanged files. Page, API-route, data-entity, and
selected-component requests include an explicit model boundary; any proposed
mutation outside that boundary is restored from the current tree and the
resulting scoped tree is validated before review. Selected preview elements
now travel as component targets with both their page route and CSS selector.
The focused R3.4 gate passes typecheck, lint, 24 backend tests, and the two
progress reducer tests.

R3.5 is complete. Generated `package.json` dependencies are parsed into a
versioned allow/block plan. Only the React/Vite/TypeScript/Tailwind toolchain
with exact/caret/tilde semver specs can become ready; package aliases, tags,
URLs, git/local paths, conflicting versions, and unapproved packages block
the plan. The recorded execution policy requires Docker, registry-only
networking, disabled lifecycle scripts, bounded time/output, and always
reports `executed: false`; PacketAgent does not run the command. Authenticated,
workspace-scoped package-plan and ZIP routes export one immutable checkpoint
with git ignores, human instructions, source, package plan, and a digest-bound
export manifest. The Builder Source view exposes plan status and download.
The focused gate passes typecheck, zero-warning lint, five package/export
tests, and 43 HTTP route tests (42 passed, one intentional Windows sandbox
skip).

R3 is complete. [`r3-filetree-depth.md`](r3-filetree-depth.md) records the
research and decisions. New and converted legacy drafts now share one
reviewable file-tree source of truth with targeted bounded repair, typed live
progress, full digest-backed review, scoped regeneration, a plan-only package
policy, and checkpoint-bound git-ready export. The full closure gate passes
typecheck, zero-warning lint, formatting, production web build, 32 web tests,
and 1,569 API tests (1,565 passed with 4 intentional live Packet-product
interoperability skips).

R4.1 is complete. Authenticated workspace aggregate and owned-app health routes
report warm-process state, active requests, request/outcome/retry/start/crash/
schema-restart/eviction counters, and bounded recent crash metadata without
starting an idle runtime or exposing raw errors. The supervised per-app Node
pool defaults to four processes, clamps configuration to 1-64, and evicts the
least-recently-used idle process. One failed request is retried, recent
failures remain degraded for five minutes, and the Builder Sandbox tab exposes
the per-app view. The focused gate passes typecheck, zero-warning lint, 48
backend tests (47 passed with one intentional Windows sandbox skip), and the
web gate.

R4.2 is complete. New publish materializations use
`packetagent.generated-app-artifact-manifest/v2`: the canonical manifest
subject binds workspace/app/checkpoint identity plus sorted file path, media
type, byte-size, and SHA-256 records; local HTML/CSS references must resolve;
missing, modified, unexpected, traversing, symlinked, substituted, or
over-limit packages fail closed. The manifest carries a required canonical
SHA-256 and can carry an optional HMAC-SHA256 signature from a 32-byte minimum
environment key that never enters the artifact. Authenticated workspace-
scoped re-verification and the Builder Publish status expose bounded,
secret-free results. Legacy list-only records remain readable but cannot pass
the v2 verifier. Research and implementation decisions are in
[`r4-generated-app-publish.md`](r4-generated-app-publish.md). The closure gate
passes typecheck, zero-warning lint, formatting, production web build, 32 web
tests, and 68 focused backend tests (67 passed with one intentional Windows
sandbox skip).

R4.3 is complete. New materialized publishes contain a standalone multi-stage
Node 22/Vite image, one generated-app Compose service, a dependency-free
static/health/SQLite CRUD server, the checkpoint's schema model, and a
migration-truth runbook. The final container is non-root with a read-only root,
bounded tmpfs/CPU/memory/PIDs, dropped capabilities, no-new-privileges, and a
named SQLite volume. Vite compiles with build networking disabled; startup
verifies the emitted `.vite/manifest.json` and all referenced assets before
readiness. `npm run verify:generated-app-publish -- <publish-directory>`
performs bounded config/build/start/health/static/CRUD/stop/restart/persistence/
delete/cleanup verification. Clean and cached Docker runs passed locally using
Engine 29.5.3 and Compose 5.1.4. Exact decisions and caveats are in
[`r4-generated-app-publish.md`](r4-generated-app-publish.md). Typecheck,
zero-warning lint, formatting, production web build, 32 web tests, and 1,577
API tests pass (1,573 passed with four intentional live interoperability
skips). Resume at R4.4 reverse-proxy/VPN examples and public-URL reachability
verification.

R4.4 is complete. Generated Compose packages bind to `127.0.0.1` by default
and seal current Caddy automatic-HTTPS, nginx TLS, and Tailscale
Serve/private-plus-Funnel/public guidance. The standalone runtime does not
trust or use forwarded headers for authorization, identity, or URL generation.
`npm run verify:generated-app-reachability -- <publish-directory> <origin>`
requires HTTPS outside loopback and separately bounds/reports URL policy, DNS,
TCP or certificate-validating TLS, liveness, exact app/checkpoint readiness,
and HTML root verification. Redirects, oversized/wrong-content responses, and
identity substitution fail closed. The Docker verifier exercises the same
reachability contract locally. PacketAgent does not claim to provision DNS,
TLS, VPN policy, or continuous monitoring. Its closure gate passed typecheck,
zero-warning lint, formatting, production web build, 32 web tests, 18 focused
backend checks, real Docker certification, and 1,581 API tests (1,577 passed
with four intentional live interoperability skips).

R4.5 and the R4 gate are complete. One exported
`reset-and-reseed` policy now appears in preview runtime health and the Builder
UI, sealed runtime config, standalone readiness/meta, publish/integration
guidance, and public reachability verification. Same-schema reopen preserves
records; preview and standalone schema-signature changes clear records and
reload seeds; generated `0001_initial.sql` is explicitly reference DDL that the
generic runtime does not execute. Generated runbooks use a stopped-service
SQLite backup/restore so the last connection checkpoints WAL before the
already-built image copies `runtime.sqlite` between its named volume and an
external directory. The real Docker certifier passes all 20
health/CRUD/restart/backup/mutate/restore/cleanup steps. Exact research and
decisions are in
[`r4-generated-app-publish.md`](r4-generated-app-publish.md). Resume at R5.1
real sandboxed TypeScript/Vite validation. The R4 closure gate passes
typecheck, zero-warning lint, formatting, production web build, 32 web tests,
34 focused backend tests, the publish materialization route, real 20-step
Docker certification, and 1,583 API tests (1,579 passed with four intentional
live interoperability skips).

W1-W10's local gates are complete under `src/workers/`, the store, migrations,
jobs, alerts, webhooks, and private
route modules. W1's design record is
[`worker-contract-plan.md`](worker-contract-plan.md). W2 preserves the
storage-neutral domain model while adding the repository and control-plane
lifecycle. W3 admits trigger deliveries and creates canonical queued runs, but
does not execute them. W4 executes those jobs through the bounded supervisor
and persists optimistic run, lease, cursor-checkpoint, event, and terminal
state. W5 upgrades those checkpoints to complete digest-chained snapshots,
adds mutation effect receipts, and recovers expired work without repeating a
completed effect. W6.1 compiles the version's requested tools into normalized
tool/verb/resource tuples and persists a deployment grant that cannot exceed
that version-bound upper limit. W6.2 normalizes each concrete operation,
preflights it before mutation receipt preparation, re-authorizes it in
`executeTool` immediately before the handler, and records a redacted decision
event. W6.3 binds opaque encrypted credentials to the immutable version,
resolves them only after that decision, pins public network destinations, and
requires the isolated no-network Docker driver for Worker commands.
W6.4 keeps checkpointed per-run counters authoritative while atomically
reserving workspace/deployment rolling capacity before provider or billable
tool execution, settling actual usage, and reconciling abandoned holds after
lease expiry. W6.5 binds registered Worker handlers to a one-shot executor
permit and closes the catalog-wide direct-access, network, filesystem, command,
credential, stale-policy, effect-ordering, and concurrent-budget bypass matrix.
W7.1 adds the durable record graph needed for attention, approval, control,
and notification state. W7.2 atomically applies or rejects every run,
deployment, and approval control with expected revisions, durable idempotency,
audit events, fenced pause, exact-run resume, and digest-only approval nonces.
W7.3 connects approval-required supervisor actions to that service: it
atomically checkpoints the pending operation and attention request, schedules
bounded escalation/expiration work, consumes only exact unexpired grants, and
rechecks the grant at the final tool boundary. W7.4 exposes the control service
through an independently mounted API with per-action permissions, strict
revision/idempotency inputs, workspace isolation, redacted state, and
first-response-only approval nonces.
W7.5 closes the gate with fresh-process approval resume and callback replay,
both approve/reject and activation/revoke race orderings, durable stop at every
supervisor phase with no subsequent action, and headless operator controls
reconstructed from durable state.
W8.1 routes every new Worker occurrence through a v2 journal with monotonic
workspace/deployment/run sequences, redacted data and envelope digests, W3C
trace/source correlation, and an atomic evidence entry. Artifact manifests bind
content descriptors to producers, evidence, and materials; stored v1 events
remain readable without fabricated evidence. JSON, dedicated SQLite, and
managed Postgres persistence/export remain equivalent.
W8.2 treats the journal as the source of truth and rebuilds disposable
cumulative projections keyed by immutable Worker version, deployment, and run.
It joins only explicit canonical source identities, journals failed tools and
phase retries, exposes missing retained references as typed gaps, and passes
order-independent replay plus storage parity.
W8.3 applies independent category windows through workspace-bound jobs with
explicit item and elapsed-time ceilings. Dry runs use a read-only load path.
Successful cleanup replaces expired summaries and metadata with digest-only
deletion evidence, removes prompt/checkpoint/result bodies only from terminal
runs, preserves effect identity for duplicate-effect safety, and delegates
artifact-byte removal to a digest-checked storage port. Persistence and read
boundaries both redact sensitive keys and known values, while rollups separate
retention-deleted source gaps from unexplained gaps.
W8.4 adds the independently authorized operations read model and routes. It
answers Worker health and run identity/state/budget/checkpoint/attention from
one server-side projection, exposes filter-bound cursor pages for runs,
attention, events, evidence, and artifacts, and streams bounded live event
connections with `Last-Event-ID` resume plus polling fallback. The workbench
uses `/runs` for canonical Workers, retains inherited Agent activity at
`/activity`, and renders Worker detail, evidence, artifact, and control states
without joining raw tables in the browser.
W8.5 closes the answerability gate with one-read identity, purpose, immutable
version/deployment, hard-budget use, provider cost, checkpoint, attention,
evidence, artifact, source-gap, and outcome assertions. It also proves
source-order replay, secret-free reads, filter/tenant-bound cursors, accessible
state semantics, and JSON/SQLite/managed-Postgres projection parity.
W9.1 freezes `packetagent.worker-package/v1` as a strict W1-aligned wire
contract. Package validation rejects undeclared fields and unknown majors,
verifies the canonical SHA-256 digest, binds optional DSSE envelopes to the
same exact bytes, and exposes a verifier callback for the authenticated trust
policy. W9.2 supplies that trust policy through one-time-returned,
digest-stored PacketADE bearer credentials bound to a workspace, actor,
operation set, expiry/revocation status, and signature requirement. It
requires an explicit local subset of the package capability upper bound and
stores integrity, provenance, compiled policy, actor, and idempotency before
deployment. W9.3 maps the accepted receipt to deterministic Worker identities,
persists the package/deployment graph, and exposes authenticated validate,
deploy, update, activate, inspect, list-runs, pause, resume, rollback, and
revoke routes. It composes W2 lifecycle transitions, W3 activation admission,
W7 revocation, and W8 run reads; its only W2 extension is the atomic forward
rollout operation needed to retire the previous deployment without a
competing-active gap or capability broadening.
W9.4 projects the W8 journal into stable versioned PacketADE deployment and
run event streams with immutable version identity, evidence links, and
explicit trace gaps. JSON pages and bounded SSE support opaque cursor and
`Last-Event-ID` resume, heartbeat/close frames, and recoverable retention
windows. Durable cursor advancement is an explicit idempotent write guarded by
a strong ETag; opening or closing SSE never acknowledges delivery.
W9.5 drives checked serialized PacketADE package and command fixtures through
the real HTTP boundary, aborts the event connection, serializes the durable
store, and constructs new trust/lifecycle/activation/control/read/event route
instances. The same receipt, deployment, queued version-pinned run,
acknowledgement, and evidence reconnect before update, pause/resume, rollback,
and revoke complete. A bounded live validation test is registered but skips
unless an operator supplies all endpoint credentials.
W10.1 upgrades W7 notification references to a legacy-compatible, versioned
channel-neutral outbox. Attention, progress checkpoint, and terminal
event/evidence writes atomically enqueue stable-idempotency delivery jobs with
attempt leases, bounded retry/expiry, dead-letter state, opaque route
references, and allowlisted redacted delivery metadata. Pending deliveries pin
their W8 source evidence; terminal delivery state permits compaction only
behind a digest-bound tombstone. The local PacketAgent transport is registered;
unconfigured external transports remain fail-closed.
W10.2 adds a PacketChat transport behind that router. External routes now
require a declared `vault:*` reference; the transport reloads the immutable
Worker/run/version/route binding, resolves the encrypted route only around the
pinned-network request, sends a stable-thread bounded state/budget/checkpoint/
evidence card, and uses the W10.1 idempotency key. Progress replaces one stable
message while attention and terminal outcomes append. Short-lived compact
HS256 callbacks bind issuer, audience, action, workspace, definition,
deployment, run, version digest, and route; constant-time verification returns
only the matching workbench URL or W8 redacted detail. W10.2 callbacks are
read-only, and no endpoint, bearer value, callback secret, or signed token is
persisted. Workspace admins configure route secrets through metadata-only
private Worker credential list/upsert/remove routes.
W10.3 adds a PacketPhone transport using the same encrypted credential and
hardened network boundaries. Its HTTPS-only configuration fixes one PacketPhone
actor, workspace role, and role-valid action subset; each message contains the
exact immutable Worker/deployment/run/version/event/evidence/revision state and
only controls valid for that actor and current state. Strict POST callbacks use
explicitly typed HS256 tokens bound to the action, workspace, definition,
deployment, run, optional attention request, version ID and digest, actor,
role, route, source event and digest, expected revision, nonce, JTI, issued-at,
and expiry. Valid callbacks delegate exclusively to W7 using a digest-derived
idempotency key, so the atomic `WorkerControlCommand` is the durable single-use
consumption record. Only PacketPhone source, role, audience, and token/nonce
digests persist; raw route secrets, bearer values, callback tokens, and
approval nonces do not. Restart replay, stale or resolved actions,
cross-workspace/version substitution, tampering, expiry, weak roles, and
callback-secret rotation all fail closed across JSON, SQLite, and managed
Postgres.
W10.4 composes those pieces into the local remote-control gate. Both transports
pass fake-endpoint contracts; Chat read-only callbacks may replay without
effects while Phone mutations remain single-use; callback credential rotation
invalidates old tokens; serialized pending deliveries resume with their
original external idempotency key; and both local-first and remote-first
operator races produce one W7 winner plus one audited revision rejection.
Dead-lettered delivery can now be atomically redriven with bounded attempts and
expiry, the original external idempotency key, a fresh scheduler job, and a
digest-only recovery journal/evidence entry. Exact redrive requests replay
without duplicate jobs, and compacted source evidence fails closed. Opt-in live
PacketChat and PacketPhone delivery probes are registered but skipped because
no endpoint configuration is present.

R5.1 is complete. Generated-source validation no longer has an opt-in or
skipped-success path: a Dockerfile/lockfile-addressed Node 22 image runs real
`tsc --noEmit` and Vite builds against a read-only input mount and ephemeral
writable workspace with networking disabled. Builder smoke consumes the same
phase result and fails closed when validation is blocked. The uninjected
`npm run verify:codegen-sandbox` proof passes. Typecheck, zero-warning lint,
formatting, production web build, 32 web tests, 62 focused tests, and the
1,583-test API suite pass (1,580 passed with three intentional live
interoperability skips).

R5.2 is also complete. Source inventory found no active `node:vm` execution
path, and a lint restriction plus repository test now keep it absent.
PacketAgent deliberately has no non-Docker untrusted-code fallback: official
Deno guidance calls for OS/VM defense in depth for arbitrary untrusted code,
so a Deno subprocess alone would overclaim isolation. Ordinary sandbox service
calls always refuse native execution. The explicitly opted-in native driver is
available only through a separate owner/admin trusted-host diagnostic path,
and status/API/UI expose that it has no isolation and cannot run untrusted
code. Workers and generated validation continue to require Docker. Typecheck,
zero-warning lint, formatting, production web build, 32 web tests, 25 focused
tests, the real Docker validator, and 1,586 API tests pass (1,583 passed with
three intentional live interoperability skips).
Implementation and research evidence are recorded in
[`r5-sandbox-isolation.md`](r5-sandbox-isolation.md).

R5.3 is complete. A single fail-closed resolver validates command/stdin size,
container working directories, explicit environment names/values, and
wall-clock requests before a driver can start. Docker receives and persisted
records expose the effective timeout, CPU, memory, PID, tmpfs, network,
filesystem, and environment policies; accepted environment values persist only
as `[redacted]`. The driver also applies private IPC, equal memory/swap bounds,
process/file-descriptor ulimits, readonly trusted mounts, and a bounded kill
path. JSON/SQLite parity and multibyte output truncation are covered. The real
`npm run verify:sandbox-policy` proof confirms root writes and outbound IP
access fail, bounded `/tmp` works, stored env is redacted, and a one-second
deadline terminates the container. Typecheck, zero-warning lint, formatting,
production web build, 32 web tests, 51 focused tests, both uninjected Docker
verifiers, and 1,598 API tests pass (1,595 passed with three intentional live
interoperability skips).

R5.4 is complete. Optional sandbox network input is not direct container
egress: operators configure exact HTTP(S) origins, PacketAgent performs bounded
GET-only prefetch through the existing W6 pinned-network client, and the
networkless container receives successful bodies plus a receipt manifest on a
read-only `/input/egress` mount. All DNS A/AAAA answers, alternate IP forms,
connected-address pinning, redirects, timeout, and response size are enforced
before Docker starts. Stored receipts omit response bodies and query values
while retaining the redacted target, status, byte count, SHA-256 digest, and
connected address. Failed broker calls create a failed audit record and never
start Docker. The real `npm run verify:sandbox-egress` proof confirms one
broker call, immutable mounted input, query redaction, and continued direct
network denial inside the container. Typecheck, zero-warning lint, formatting,
production web build, 32 web tests, 66 focused tests, the real Docker verifier,
and 1,608 API tests pass (1,605 passed with three intentional live
interoperability skips).

R5.5 is complete. Generated previews and their runtime API now require a
different browser host from the workbench; production requires exact,
different HTTPS origins and rejects a port-only split. Workbench sessions stay
host-only. Versioned read/interactive capabilities bind workspace, app,
checkpoint, scope, expiry, and interactive parent origin, travel only in URL
fragments, and exchange for a Secure/HttpOnly/partitioned single-app cookie.
Shared previews cannot mutate runtime state. Per-response nonce CSP,
scope-specific `frame-ancestors`, primary/preview route denial, and a bounded
exact-origin/source message bridge replace the prior same-origin iframe DOM
access. Caddy/nginx examples live under
`dev/deployment/examples/preview-origin/`; `npm run
verify:preview-isolation` is the temporary-state executable proof. The R5.5
closeout passed typecheck, zero-warning lint, formatting, the production web
build, 33 web tests, 62 focused preview/security tests, all four cumulative R5
executable verifiers, and 1,617 API tests (1,614 passed with three intentional
live interoperability skips). The preview verifier passed 30 deterministic
assertions plus its real Chromium proof.

R5.6 is complete and the cumulative R5 gate passes. The codegen validator
image now defaults to numeric non-root. The PacketAgent control-plane Compose
service and standalone generated-app Compose package explicitly declare
non-root users, read-only roots, all capabilities dropped,
no-new-privileges, process/ulimit bounds, bounded tmpfs, and init handling.
Generated-app certification inspects those settings on the running container.
`npm run verify:container-hardening` resolves both Compose contracts, inspects
the built validator image, and proves the live sandbox has UID/GID 65534,
zero effective capabilities, `NoNewPrivs=1`, cgroup `pids.max=64`, and a
denied root write. The R5 closure passed typecheck, zero-warning lint,
formatting, the production web build, 33 web tests, 16 focused
container/publish tests, all five cumulative R5 executable verifiers, and
1,620 API tests (1,617 passed with three intentional live interoperability
skips).

R6.1 is complete. `email_send` now has a default Nodemailer-backed Agent path
and a canonical Worker SMTP runtime port. Worker sends use only declared
encrypted `smtp_config` references, authorize recipient resources before
resolution, bind the sender to the credential, reuse W6 public-address
validation/pinning, require certificate-validated implicit TLS or STARTTLS,
and expose only bounded delivery metadata. `npm run verify:smtp` proves seven
encrypted-store, policy-order, address, TLS, sender, default-path, and
redaction assertions without contacting a live SMTP server. Research and
decisions are recorded in
[`r6-smtp-transport.md`](r6-smtp-transport.md).

R6.2 is complete. The Builder makes one bounded provider-routed AgentTemplate
authoring call, uses provider-appropriate structured output, rejects
unregistered tools or deterministic trigger/schedule substitution, validates
typed non-sensitive inputs and all string/list limits, and redacts
secret-shaped assignments. Provider unavailable/error, incomplete, and
invalid results return the deterministic draft with visible provenance.
Approval retains the existing Agent API. `npm run verify:agent-template`
certifies the valid canonical Worker draft projection and its required
`projection.requires_validation` warning without making live calls. Research
and decisions are recorded in
[`r6-agent-template-authoring.md`](r6-agent-template-authoring.md).

R6.3 is complete. Agent authoring, pre-run readiness, the saved exact model,
and the restart-safe execution route now share one canonical preset
resolution. Readiness reports the provider/model, registration, secret-free
environment/workspace-vault/local key source, configured-but-unverified model
availability, and catalog streaming/tool-use/structured-output capability.
Missing runtimes block; local providers remain explicitly unverified; and
model-dependent capabilities remain visible for the R6.4 evaluation.
`npm run verify:agent-readiness` certifies seven assertions without live
provider calls. Research and decisions are recorded in
[`r6-agent-readiness.md`](r6-agent-readiness.md).

R6.4 is complete. Builder and Agent editing now persist bounded non-secret
memory, typed input examples, expected-output review context, and required
evaluation tools. Builder approval saves examples before readiness or approval
gates, then executes the real bounded Agent loop; registered enabled tools keep
their explicit launch approval. The versioned evaluation fails closed over
saved-versus-actual inputs, run status, redacted non-empty output, and required
successful tool calls. The same evidence survives JSON, SQLite, managed
Postgres, dedicated Agent-run backfill/verification, Agent detail, and run
trace derivation. Expected output is human review context, not a fabricated
second-model score. `npm run verify:agent-first-run` certifies seven assertions
without network calls. Research and decisions are recorded in
[`r6-agent-first-run-evaluation.md`](r6-agent-first-run-evaluation.md).

The exact next slice is R6.5 under
[`R6 - agent authoring and execution depth`](../BACKLOG.md#r6---agent-authoring-and-execution-depth):
add signed, versioned Agent/Worker import and export.
After each gate passes, continue through R6-R8 using that backlog's unchecked
checklists; use the loop document only for execution mechanics. Historical
D/phase/track documents have been reconciled there and must not be resumed
independently.

## Canonical documents

- Product truth: [`../README.md`](../README.md)
- Short direction: [`roadmap.md`](roadmap.md)
- Work ledger and gates: [`../BACKLOG.md`](../BACKLOG.md)
- W6-W10 and inherited execution map: [`worker-implementation-loops.md`](worker-implementation-loops.md)
- PacketADE contract: [`packetade-packetagent-handoff.md`](packetade-packetagent-handoff.md)
- W1 contract plan and decisions: [`worker-contract-plan.md`](worker-contract-plan.md)
- W8 observability/evidence decisions: [`worker-observability-plan.md`](worker-observability-plan.md)
- R6.4 first-run evaluation decisions:
  [`r6-agent-first-run-evaluation.md`](r6-agent-first-run-evaluation.md)
- Rename compatibility: [`taskloom-to-packetagent.md`](taskloom-to-packetagent.md)
- Verification: [`TESTING.md`](TESTING.md)
- Shipped history: [`../CHANGELOG.md`](../CHANGELOG.md)
- Pre-W10.3 W1-W10.2 implementation-report snapshot:
  [`../output/pdf/packetagent-worker-implementation-report.pdf`](../output/pdf/packetagent-worker-implementation-report.pdf)
- Matching pre-W10.3 Packet-suite integration snapshot:
  [`../output/pdf/packet-suite-integration-reality-check.pdf`](../output/pdf/packet-suite-integration-reality-check.pdf)

Historical documents are labeled at their top and must not override this
handoff, the roadmap, or the backlog.

## Last verified gates

- `npm run typecheck` - passed
- `npm run lint` - passed with 0 errors and 0 warnings
- `npm run format:check` - passed
- `npm run build:web` - passed with Vite 7.3.6 and esbuild 0.27.2
- `npm run test:api` - 1,639 passed, 3 intentionally skipped live probes, 0
  failed (1,642 total)
- `npm run test:web` - 37 passed, 0 failed
- focused R6.4 memory, input-example, real first-run, approval, deterministic
  evidence, redaction, trace, SQLite repository/dual-write/backfill,
  managed-Postgres, route, and UI utility gate - 81 passed, 0 failed
- `npm run verify:agent-first-run` - all 7 versioned-evidence, saved-input,
  actual-output, required-tool, deterministic-pass, fail-closed, semantic-note,
  and secret-redaction assertions passed without a live provider, tool, or
  network call
- focused R6.3 provider resolution, secret-free key source, model availability,
  capability readiness, stable provider route, service restart, API route, and
  UI labeling gate - 83 passed, 0 failed
- `npm run verify:agent-readiness` - all 7 exact preset, key-source,
  conditional-capability, configured-model, keyless-local, unresolved-runtime,
  and persisted-route assertions passed without a live provider or external
  tool call
- focused R6.2 AgentTemplate schema, best-effort JSON, semantic constraints,
  redaction, deterministic fallback, service merge, Agent approval, route
  compatibility, and UI provenance gate - 79 passed, 0 failed
- `npm run verify:agent-template` - all 7 structured-schema, registered-tool,
  redaction, deterministic-trigger, invalid-substitution fallback, canonical
  Worker projection, and lifecycle-warning assertions passed without a live
  provider or external tool call
- focused R6.1 SMTP, credential, network, runtime-binding, policy-order, and
  registry-bypass gate - 35 passed, 0 failed
- `npm run verify:smtp` - all 7 encrypted-storage, address-pinning, TLS,
  sender-binding, denial-order, allowed-order, and default-Agent-path
  assertions passed without sending live email
- focused R2 canonical catalog, provider request mappings, vLLM constrained
  decoding and one fallback, malformed tool-input correction bound,
  local single-file authoring, Gemini/OpenRouter vault storage and request-time
  resolution, secret-free workspace readiness, provider-kind migration, and
  route/storage parity checks - 245 passed, 1 intentional Windows sandbox
  skip, 0 failed
- focused W7 control-schema, graph-integrity, atomic command races,
  pause/resume/stop/revoke, approval/rejection, nonce non-persistence,
  approval-required checkpointing, exact one-time/run grant consumption,
  final-boundary grant rechecks, escalation deduplication, pause/reject
  expiration, independent operator RBAC, redacted control projections, strict
  mutation inputs, no-store approval nonce delivery, workspace isolation,
  fresh-process approval resume, callback replay, both approve/reject and
  activation/revoke race orderings, stop at every supervisor phase, headless
  operator reconstruction, supervisor fencing, paused-job draining,
  export-isolation, and
  JSON/SQLite/managed-Postgres parity checks; production-catalog executor/direct-access guards,
  denial-before-credential/budget/effect/network ordering, linked/case-aliased
  host paths, hostile command arguments, stale/tampered policy, atomic
  rolling-budget concurrency, worst-case provider reservation, billable-action
  ordering, idempotent settlement/release, lease-expiry reconciliation, Worker
  credential isolation, public A/AAAA and connected-address validation,
  redirect denial, Docker-only execution, capability compilation/narrowing,
  activation, supervisor, checkpoint-chain, effect replay,
  recovery/quarantine, lease/revision, scheduler, route, and
  JSON/SQLite/managed-Postgres parity checks - passed
- focused W8.1 v2 envelope/evidence pairing, monotonic workspace/deployment/run
  streams, W3C trace and provider/tool/effect/control correlation, event and
  evidence tamper detection, artifact content/provenance manifests, legacy v1
  reads, cursor filtering, export isolation, migration, and
  JSON/SQLite/managed-Postgres parity checks - passed
- focused W8.2 ordered-source replay, fresh-process rebuild, version/deployment/
  run aggregation, provider/tool/effect/retry/queue/approval/checkpoint/budget/
  artifact/outcome metrics, exit-predicate matches, missing-source gaps,
  workspace isolation, and stable JSON/SQLite/managed-Postgres parity checks -
  passed
- focused W8.3 persistence/read redaction, known-secret removal, separate
  category windows, mutation-free dry runs, item/time bounds, workspace
  isolation, active-run preservation, terminal prompt/checkpoint/effect
  compaction, digest-checked artifact deletion, idempotent tombstones,
  retention-explained source gaps, and stable JSON/SQLite/managed-Postgres
  parity checks - passed
- focused W8.4-W8.5 one-read Worker
  identity/purpose/version/budget/checkpoint/attention/evidence projection,
  health aggregation, stable filter/tenant-bound cursors, independent route
  authorization, bounded `Last-Event-ID` SSE reconnect, source-order rebuild,
  secret-free reads, accessible loading/error/empty/ready states, and
  JSON/SQLite/managed-Postgres operations-read-model parity checks - passed
- focused W9.1 strict package shape, W1 content/provenance reuse, canonical
  byte/digest reproducibility, property-order independence, Unicode and
  non-JSON rejection, changed-content detection, missing-bound rejection,
  unsupported-major compatibility, undeclared secret-field rejection, DSSE
  payload substitution, and required/untrusted signature checks - passed
- focused W9.2 workspace/actor/operation authentication, digest-only and
  revocable credentials, local capability narrowing, signature-policy
  enforcement, pre-deployment idempotency receipts, durable rate-limit/audit
  outcomes, secret-free exports, persistence-integrity rejection, and
  JSON/SQLite/managed-Postgres parity checks - passed
- focused W9.3 lifecycle-dry validation, field-addressed transport errors,
  authenticated deploy/inspect/list/control, exact activation replay, atomic
  forward update, locally narrowed update/rollback grants, unbound/
  cross-workspace/stale rejection, durable package/deployment graph integrity,
  secret-free export, migration, and JSON/SQLite/managed-Postgres parity
  checks - passed
- focused W9.4 stable versioned event projection, progress/approval/terminal/
  budget mapping, evidence links, trace gaps, cursor and `Last-Event-ID`
  resume, bounded SSE heartbeat/close, no-ack streaming, idempotent monotonic
  acknowledgement, strong ETag conflicts, restart reconstruction,
  stream-bound cursors, retention-window recovery, secret isolation, and
  JSON/SQLite/managed-Postgres parity checks - passed
- focused W9.5 serialized validate/deploy/activate, real SSE abort, token-free
  durable-store round trip, fresh service reconstruction, acknowledged
  reconnect, pinned queued-run/job preservation, evidence resolution, update,
  pause/resume, rollback, revoke, and transition-event projection - passed;
  live network validation is registered and conditionally skipped because no
  endpoint credentials are configured
- focused W10.1 event/evidence/outbox/job atomicity and rollback, legacy
  delivery compatibility, stable idempotency across retries, attempt
  exhaustion, expiry, dead-letter state, scheduler registration, metadata and
  secret redaction, pending-evidence retention pinning, terminal tombstones,
  attention/progress/terminal production paths, and
  JSON/SQLite/managed-Postgres parity checks - passed
- focused W10.2 encrypted route resolution, pinned-network request and
  idempotency semantics, bounded state/budget/checkpoint/evidence cards,
  stable progress replacement, secret non-persistence, transport delegation,
  retry classification, HS256 signature/tamper/expiry/cross-workspace binding,
  redacted inspect projection, and no-store callback routes - passed
- focused W10.3 all-five-action delivery, W7 role narrowing, stable retry
  payloads, pinned-network delivery, strict POST/no-store callbacks, durable
  restart replay rejection, stale/resolved/cross-workspace/cross-version/
  tamper/expiry rejection, callback-secret rotation, token and secret
  non-persistence, and JSON/SQLite/managed-Postgres persistence/export parity -
  passed
- focused W10.4 dual fake-endpoint delegation, pending-delivery serialization
  and restart, stable external idempotency, bounded audited dead-letter
  redrive and replay, Chat read-only replay and credential rotation, Phone
  single-use replay and credential rotation, and local-first/remote-first W7
  race semantics - passed; live PacketChat and PacketPhone delivery probes are
  registered and conditionally skipped because no endpoint configuration is
  present
- `git diff --check` - passed
- compatibility-only old-name scan - passed

Known inherited quality debt:

- full and production dependency audits each report two high package entries
  for the same accepted, unreachable React Router RSC advisory; and
- ESLint is clean with zero errors and zero warnings.

Do not use `npm audit fix --force` or format the entire repository as an
incidental part of the Worker loops. Track those cleanups separately in the
backlog.

## First commands in the new Codex project

```powershell
Set-Location D:\projects\PacketAgent
git branch --show-current
git status --short
git remote -v
npm run typecheck
```

Expected branch: `codex/packetagent-foundation`.

Expected remotes: PacketAgent `origin` and the read-only historical
`taskloom-source`.

Expected status after the latest pushed R6.4 checkpoint: clean. Stop if the active folder is
`D:\projects\taskloom`, the foundation commit is absent, or unrelated changes
appear unexpectedly.
