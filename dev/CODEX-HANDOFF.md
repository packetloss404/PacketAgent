# Codex project handoff

Last updated: 2026-07-27.

This is the authoritative starting point when opening `D:\projects\PacketAgent`
as a new project in the Codex app.

## Open this project

- Project folder: `D:\projects\PacketAgent`
- Active branch: `codex/packetagent-foundation`
- Historical source remote: `taskloom-source`
- PacketAgent `origin`: not configured
- Original TaskLoom checkout: `D:\projects\taskloom`, preserved and unchanged

Do not push PacketAgent changes to `taskloom-source`. Create and confirm the
new PacketAgent repository before adding an `origin`.

The repository-wide rename, compatibility migration, documentation reset,
carried Builder layout fix, and rename-sensitive test corrections are preserved
in foundation commit `d60cd47`. W1-W7 and W8.1-W8.3 are implemented as
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
- agent definitions and capped tool-use runs;
- schedules, webhooks, alerts, persistent jobs, retries, and dead-letter;
- six BYO model providers and local OpenAI-compatible/Ollama endpoints;
- tool approvals, encrypted secrets, RBAC, audit, sandbox, and Playwright;
- outbound HTTP, Slack, GitHub, email, SQL, and scoped shell tool adapters;
- bounded app-code validation repair, per-app SQLite runtime, and supervised
  runtime workers;
- JSON, SQLite, and managed Postgres storage paths; and
- operational health, metrics, and provider cost records.

Not shipped:

- hardened Worker-specific browser, SMTP, and SQL drivers (those paths fail
  closed for Worker runs);
- external notification transports and the consolidated Worker
  health/cost/evidence API and UI; and
- PacketADE-to-PacketAgent deployment endpoints.

Do not describe those missing Worker features as implemented.

## Exact resume point

Continue **W8 - Evidence, cost, retention, and operations UI** in
[`../BACKLOG.md`](../BACKLOG.md).

W1-W7 and W8.1-W8.3 are complete under `src/workers/`, the store, migrations,
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

The exact next slice is
[`W8.4 - Expose API and UI`](worker-implementation-loops.md#w84---expose-api-and-ui).
After each gate passes, continue through W8-W10 and then R1-R8 using that
document's autonomous execution protocol. Historical D/phase/track documents
have been reconciled there and must not be resumed independently.

## Canonical documents

- Product truth: [`../README.md`](../README.md)
- Short direction: [`roadmap.md`](roadmap.md)
- Work ledger and gates: [`../BACKLOG.md`](../BACKLOG.md)
- W6-W10 and inherited execution map: [`worker-implementation-loops.md`](worker-implementation-loops.md)
- PacketADE contract: [`packetade-packetagent-handoff.md`](packetade-packetagent-handoff.md)
- W1 contract plan and decisions: [`worker-contract-plan.md`](worker-contract-plan.md)
- W8 observability/evidence decisions: [`worker-observability-plan.md`](worker-observability-plan.md)
- Rename compatibility: [`taskloom-to-packetagent.md`](taskloom-to-packetagent.md)
- Verification: [`TESTING.md`](TESTING.md)
- Shipped history: [`../CHANGELOG.md`](../CHANGELOG.md)

Historical documents are labeled at their top and must not override this
handoff, the roadmap, or the backlog.

## Last verified gates

- `npm run typecheck` - passed
- `npm run lint` - passed with 0 errors and 145 inherited warnings
- `npm run build:web` - passed
- `npm run test:api` - 1,451 passed, 1 skipped, 0 failed
- `npm run test:web` - 25 passed, 0 failed
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
- `git diff --check` - passed
- compatibility-only old-name scan - passed

Known inherited quality debt:

- repo-wide `npm run format:check` flags 367 files;
- full dependency audit reports 11 advisories, including 2 critical
  development-tree advisories; and
- production-only audit reports 5 advisories: 1 low, 1 moderate, 3 high,
  0 critical.

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

Expected remote: `taskloom-source` only.

Expected status after the W8.3 commit: clean. Stop if the active folder is
`D:\projects\taskloom`, the foundation commit is absent, or unrelated changes
appear unexpectedly.
