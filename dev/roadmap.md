# PacketAgent roadmap

This is the short product direction. Detailed acceptance criteria and status
live in [`../BACKLOG.md`](../BACKLOG.md); executable slices and autonomous
continuation order live in
[`worker-implementation-loops.md`](worker-implementation-loops.md).

The automatic self-host MVP sequence **PA0, W1-W10, and R1-R8 is complete**.
No R9 is implied. The short repository/session resume point lives in
[`../HANDOFF.md`](../HANDOFF.md); the implementation and gate ledger is
[`../BACKLOG.md`](../BACKLOG.md). Starting later work requires an explicit
owner decision.
W6.1 capability compilation, W6.2 immediate tool-boundary enforcement,
W6.3 credential/network/process hardening, and W6.4 atomic rolling budgets are
complete. W6.5 closes the adversarial bypass gate across every registered tool.
W7's durable attention, atomic controls, supervisor integration, independent
operator API, and restart/kill race gate are also complete. W8.1's versioned,
digest-bound event/evidence and artifact-provenance contract, W8.2's
deterministic version/deployment/run rollups, and W8.3's bounded retention,
redaction, and deletion-evidence jobs are complete. W8.4's consolidated
operations read model, cursor APIs, bounded resumable event stream, and
canonical Worker list/detail workbench and W8.5's answerability, accessibility,
cursor, tenant, and storage-parity gate are also complete. W9.1 freezes the
strict, digest-bound WorkerPackage v1 contract and optional DSSE verification
seam. W9.2 adds the workspace/actor-bound PacketADE credential, local
capability acceptance, durable pre-deployment receipt, rate limit, audit, and
storage parity. W9.3 adds the authenticated validate/deploy/update/activate/
inspect/list/pause/resume/rollback/revoke API, immutable package/deployment
bindings, atomic forward rollouts, and JSON/SQLite/managed Postgres parity.
W9.4 projects W8 evidence events through versioned JSON and bounded SSE,
supports stable `Last-Event-ID` reconnect, exposes retention-window recovery,
and persists explicit idempotent cursor acknowledgements behind strong ETags.
W9.5 closes the local handoff gate through serialized package/command
fixtures, client disconnect, durable-store serialization, fresh-process
reconstruction, reconnect, evidence, update, pause/resume, rollback, and
revoke. W10.1 now adds the versioned channel-neutral outbox, atomic
event/evidence binding, stable idempotency, bounded scheduler retry/expiry,
dead-letter state, and retention-safe provenance across all three storage
modes. W10.2 now adds encrypted PacketChat route resolution, pinned-network
delivery of bounded replaceable progress cards, and short-lived exact-binding
open/inspect callbacks. W10.3 adds encrypted HTTPS-only PacketPhone delivery,
role-bounded approve/reject/pause/stop/revoke controls, exact-binding signed
POST callbacks, and durable one-use consumption through W7. W10.4 now closes
the local remote-control gate with fake-endpoint contracts, local/remote race
orderings, restart/replay/credential-rotation checks, and audited bounded
dead-letter redrive. R1 repository health is complete. R2 now centralizes
provider/model/capability policy, maps native and conditional structured
responses, bounds vLLM compatibility fallback and malformed-tool correction,
adds Gemini/OpenRouter workspace-vault parity, and exposes secret-free
readiness. R3 now closes canonical file-tree repair, conversion, live progress,
digest-backed review, targeted regeneration, plan-only package policy, and
git-ready export. R4.1 adds authenticated aggregate/per-app runtime health,
bounded crash visibility and operational counters, a Builder surface, and a
documented 1-64-process supervised warm-pool limit. R4.2 adds checkpoint-bound
artifact manifest v2 sealing, per-file and canonical checksums, optional HMAC
signing, bounded HTML/CSS static-asset validation, tamper/substitution checks,
and authenticated re-verification. R4.3 adds the actual standalone
Node/Vite/SQLite publish image, hardened single-service Compose contract, and
bounded Docker build/health/CRUD/restart-persistence verifier. R4.4 adds
loopback-by-default port binding, sealed Caddy/nginx/Tailscale examples, and
bounded DNS/TCP/TLS/HTTP reachability bound to exact package identity. R4.5
closes the loop with one visible `reset-and-reseed` policy, same-schema and
schema-change characterization, reference-only generated DDL, and a real
stopped-service SQLite backup/restore proof. R5.1 now makes generated
TypeScript/Vite validation mandatory through a lockfile-addressed,
network-disabled Docker image and fails closed when isolation is unavailable.
R5.2 defines the non-Docker contract: there is no supported untrusted fallback;
native host execution is explicit owner/admin trusted diagnostics only, and
production `node:vm` imports are prohibited. R5.3 centralizes the sandbox
policy, enforces exact wall-clock/CPU/memory/PID/tmpfs bounds, read-only
filesystem and explicit redacted environment rules, and proves deny-all egress
with real Docker. R5.4 provides optional exact-origin, GET-only input prefetch
through the W6 pinned-network client while the container remains networkless;
receipts redact query values and bind mounted content by digest. R5.5 separates
generated code from the workbench browser authority, exchanges
checkpoint-bound fragment capabilities for partitioned app-path cookies,
applies nonce CSP and exact-parent framing, and moves click-to-edit onto a
validated message bridge. R5.6 closes the containment gate: the validator
image, control-plane Compose service, generated-app package, and live
untrusted sandbox now share an executable non-root/read-only-root/
capability-drop/no-new-privileges/process-limit matrix. R6.1 now adds a
TLS-only, public-address-pinned default SMTP transport, with Workers resolving
strict `smtp_config` values from the encrypted vault only after recipient
policy approval. R6.2 replaces heuristic-only agent drafting with one bounded,
schema-constrained provider authoring call plus deterministic semantic
validation, registered-tool/trigger bounds, visible fallback provenance,
review-before-save, and a certified canonical Worker draft projection. R6.3
now aligns Agent authoring, readiness, saved model, and restart-safe
execution to one canonical preset resolution, with secret-free credential
source, configured-but-unverified model state, and explicit capability
support. R6.4 adds bounded editable non-secret memory, persisted typed input
examples, real first-run execution behind the existing tool approval, and
versioned deterministic input/run/output/tool evidence across every storage
mode and the Agent run trace. R6.5 adds the strict signed
`packetagent.agent-worker-bundle/v1` transfer boundary: full portable Agent
authoring, its deterministic Worker draft projection, RFC 8785/SHA-256
digests, Ed25519 DSSE, explicit publisher-fingerprint trust, secret/local-state
exclusion, reviewed preflight, and idempotent paused import. R6.6 then routes
every accepted legacy Agent launch and active schedule through deterministic
Worker materialization, canonical activation, the fenced supervisor, W7
control, and a linked compatibility read model with JSON, SQLite, and managed
Postgres parity. R6 is complete. R7 decomposes the five audited frontend/route
modules, adds shared accessible async-state and keyboard tab primitives,
centralizes browser formatting, fixes the incremental styling direction, and
passes component plus real-browser Builder/Worker coverage. R8 binds quality
transcripts to generated-app checkpoints and closes focused app/Worker release
paths, regressions, claim audit, cleanup, built-JavaScript startup, and actual
production-image boot. Exact evidence lives in
[`r7-frontend-maintainability.md`](r7-frontend-maintainability.md) and
[`r8-release-reliability.md`](r8-release-reliability.md).

R1 is complete. Its persistence slice reuses managed Postgres pools,
validates SQLite migration/restore integrity and foreign keys, rejects corrupt
restore candidates without replacing current data, and preserves target-only
managed-backfill records. The jobs single-writer/workspace-scoping audit is
also closed with a single canonical SQLite transaction, workspace-qualified
job controls, and collision/race coverage. The backend security/startup slice
now makes `npm start` a single non-watch server, defers bootstrap side effects
until explicit startup, applies baseline headers/CSP, and authorizes opt-in
artifact reads against the owning workspace and exact run. Frontend safety,
render recovery, multi-secret redaction, the preview iframe contract, audited
dead controls, primary keyboard semantics, and stale web branding are also
closed. The storage-authority/cutover decision and deliberate dependency
disposition are now closed, including the documented unreachable React Router
RSC exception. The 326-file Prettier baseline, 145-warning ESLint baseline, and
native-button-type audit are closed. Typecheck, lint, formatting, production
build, 30 web tests, and the 1,525-test API suite pass;
[`r1-repository-health-audit.md`](r1-repository-health-audit.md) records
supporting evidence while `BACKLOG.md` remains the ledger.

## North star

PacketAgent is a self-hosted runtime for creating and operating autonomous workers.

A worker:

- has a versioned objective, execution profile, tools, triggers, policies, and exit conditions;
- wakes on a manual request, schedule, webhook, queue message, or alert;
- plans, acts, evaluates, and retries within explicit limits;
- checkpoints enough state to resume safely after a crash or restart;
- stops, pauses, or requests approval instead of running without bounds; and
- produces an auditable record of decisions, tool calls, costs, artifacts, and outcomes.

"Always on" means the control plane remains available and workers can wake whenever needed. It does not mean every worker continuously consumes model tokens.

## Current foundation

The TaskLoom codebase brought forward a strong implementation substrate:

- agent definitions, runs, SSE transcripts, and a bounded tool loop;
- schedules, webhooks, alerts, a persistent jobs queue, retries, and dead-letter handling;
- six BYO model providers plus local-model support;
- tool approval tokens, encrypted secrets, RBAC, and audit records;
- Docker/native sandbox execution and Playwright browser automation;
- JSON, SQLite, and managed Postgres storage paths; and
- operations, metrics, provider-call cost data, and health surfaces.

These pieces now support the durable Worker lifecycle through crash-safe recovery. The existing builder remains supported and becomes the worker creation studio. Prompt-to-app generation remains an inherited secondary capability.

## Completed W1-W5 foundation

### 1. Durable Worker contract - complete

The storage-neutral canonical Worker, WorkerVersion, WorkerDeployment, WorkerRun, WorkerCheckpoint, WorkerPolicy, and WorkerTrigger records, runtime validators, transition guards, immutable-version checks, and legacy agent/workflow projections are implemented under `src/workers/`.

### 2. Worker persistence and activation - complete

Canonical Worker records persist in JSON, SQLite, and managed Postgres. Private lifecycle routes support immutable version validation plus draft, deploy, activate, pause, resume, retire, and rollback operations with durable command receipts, events, idempotent replay, and optimistic concurrency.

### 3. Trigger adapters - complete

Manual, cron, webhook, alert, and queue deliveries now enter one versioned activation envelope and durable inbox. Intake validates the deployed input schema, encrypts large or sensitive payloads behind expiring references, preserves W3C trace context, deduplicates delivery identity atomically, and creates one version-pinned queued run plus execution job across JSON, SQLite, and managed Postgres.

### 4. Bounded supervisor loop - complete

The canonical `worker.run` handler now executes a port-isolated plan-act-evaluate-checkpoint-decide reducer around the existing provider router and tool executor. It enforces elapsed-time, iteration, provider-cost, failure, retry, and tool-call limits; requires declared exit predicates; persists optimistic run revisions and cursor checkpoints; and stops on cancellation, revocation, lease expiry, or fencing loss. Scheduler shutdown releases claimed work for later recovery.

### 5. Checkpoint and recovery - complete

Digest-chained immutable snapshots persist the run cursor, full working memory, completed actions, pending approvals, artifacts, effect receipt IDs, trace, and remaining budgets. Startup and periodic reconciliation resume safe expired work from the exact action cursor. Prepared/completed receipts replay completed mutations, reconcile supported operations, and quarantine uncertain or corrupt recovery state.

## Completed W6-W10 flagship sequence

### 6. Permission and budget policy - complete

Version-digest-bound verb/resource capability compilation, deployment narrowing,
normalized operation descriptors, immediate pre-handler enforcement, and
redacted policy-decision events are complete. Workspace-scoped opaque
credentials, pinned public network destinations, redirect denial, fail-closed
external adapters, and Docker-only autonomous command execution are also
complete. Provider cost and externally billable actions now reserve and settle
durable workspace/deployment rolling capacity before execution, with
lease-expiry reconciliation. Production registry handlers require a one-shot
executor permit, and the adversarial matrix covers direct access, network,
filesystem, command, credential, stale-policy, effect-ordering, and concurrent
budget bypasses.

### 7. Attention and operator controls - complete

Durable attention requests, approval grants, control commands, and
notification-delivery references are implemented across all storage modes.
The atomic service executes revision-checked, idempotent pause, resume, stop,
revoke, approve-once, approve-for-run, and reject commands while fencing live
supervisors and preserving paused checkpoints and budgets. Approval-required
operations now checkpoint the exact action, persist and notify durable
attention, consume exact unexpired grants at the execution boundary, and apply
the version's explicit pause/reject expiration disposition. Independently
mounted operator routes now authorize inspect, run-control,
deployment-control, and approval actions separately and return concise,
redacted state. Fresh-process approval replay, approve/reject races, stop at
every supervisor phase, activation/revoke races, and headless route controls
pass without later work.

### 8. Worker health, cost, and evidence - complete

The v2 event envelope, monotonic deployment/run streams, atomic evidence
entries, source correlations, artifact manifests, digests, W3C trace checks,
legacy v1 reads, and three-backend persistence are complete. Deterministic
cumulative views now roll provider/tool/effect calls, retries, queue health,
approvals, checkpoints, budgets, artifacts, outcomes, and explained source
gaps up by immutable Worker version, deployment, and run. Separate metadata,
summary, prompt, tool-payload, and artifact retention windows now execute
through bounded workspace jobs with dry-run metrics and digest-only deletion
evidence. One server-side read model now makes "what is running, why, at what
cost, and what needs me" answerable from the accessible canonical Worker
list/detail workbench without client-side raw-table joins.

### 9. PacketADE handoff - complete

WorkerPackage v1 now freezes the strict W1-aligned envelope, canonical digest
bytes, artifact references, compatibility fixtures, and optional DSSE
verification seam. The Packet-product trust boundary now authenticates
workspace-bound PacketADE service actors, narrows package capabilities through
local policy, persists token-safe integrity/idempotency receipts, composes the
canonical deployment/control services, and projects reconnectable progress,
approval, completion, failure, and budget events with durable acknowledgements.
The serialized W9.5 gate now proves those records, a queued version-pinned run,
and its evidence survive client disconnect and service reconstruction before
later update, pause/resume, rollback, and revoke operations.

### 10. PacketChat and PacketPhone routes - local gate complete

The channel-neutral notification outbox and PacketChat adapter are complete.
PacketChat receives bounded threaded Worker summaries and authenticated
inspect/open callbacks. PacketPhone receives role-bounded approval and kill
controls whose signed callbacks consume the same atomic W7 commands. The local
gate now certifies both adapters under local/remote races, credential rotation,
restart, replay, and dead-letter recovery. Live probes remain conditionally
skipped until external PacketChat and PacketPhone settings are supplied.

## Decision-gated candidates

The runtime can now execute integrations and Worker templates within the
completed safety model, but expanding the connector catalog or shipping new
starters requires an explicit owner choice in `BACKLOG.md`. The same rule
applies to:

- App template gallery and deeper prompt-to-app builder polish.
- Cross-node worker package sharing and a signed template marketplace.
- Advanced authoring modes such as schema-first or test-driven generation.
- Multi-region active-active operation.

## Non-goals

- Unbounded autonomous action or endless model loops.
- Silent elevation of tool, credential, network, or filesystem access.
- Hosted SaaS as a prerequisite for the self-hosted product.
- Lock-in to one model provider.
- Telemetry or phone-home behavior.
- Closed-source services required for core operation.

## Decision rule

Near-term work should improve at least one of these properties: bounded, permissioned, resumable, auditable, observable, or easy to deploy from another Packet product. Builder-only polish does not outrank the Worker lifecycle unless it removes a direct blocker.
