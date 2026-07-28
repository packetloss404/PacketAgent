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
in foundation commit `d60cd47`. W1-W6 and W7.1-W7.3 are implemented as
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
- independent W7 operator APIs, external notification transports, the
  restart/kill gate, consolidated Worker-level evidence, and cost rollups; and
- PacketADE-to-PacketAgent deployment endpoints.

Do not describe those missing Worker features as implemented.

## Exact resume point

Continue **W7 - Attention, approval, and kill controls** in
[`../BACKLOG.md`](../BACKLOG.md).

W1-W6 and W7.1-W7.3 are complete under `src/workers/`, the store, migrations,
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
rechecks the grant at the final tool boundary. The control service remains
internal until W7.4.

The exact next slice is
[`W7.4 - Add independent operator APIs`](worker-implementation-loops.md#w74---add-independent-operator-apis).
After each gate passes, continue through W7-W10 and then R1-R8 using that
document's autonomous execution protocol. Historical D/phase/track documents
have been reconciled there and must not be resumed independently.

## Canonical documents

- Product truth: [`../README.md`](../README.md)
- Short direction: [`roadmap.md`](roadmap.md)
- Work ledger and gates: [`../BACKLOG.md`](../BACKLOG.md)
- W6-W10 and inherited execution map: [`worker-implementation-loops.md`](worker-implementation-loops.md)
- PacketADE contract: [`packetade-packetagent-handoff.md`](packetade-packetagent-handoff.md)
- W1 contract plan and decisions: [`worker-contract-plan.md`](worker-contract-plan.md)
- Rename compatibility: [`taskloom-to-packetagent.md`](taskloom-to-packetagent.md)
- Verification: [`TESTING.md`](TESTING.md)
- Shipped history: [`../CHANGELOG.md`](../CHANGELOG.md)

Historical documents are labeled at their top and must not override this
handoff, the roadmap, or the backlog.

## Last verified gates

- `npm run typecheck` - passed
- `npm run lint` - passed with 0 errors and 145 inherited warnings
- `npm run build:web` - passed
- `npm run test:api` - 1,419 passed, 1 skipped, 0 failed
- `npm run test:web` - 25 passed, 0 failed
- focused W7 control-schema, graph-integrity, atomic command races,
  pause/resume/stop/revoke, approval/rejection, nonce non-persistence,
  approval-required checkpointing, exact one-time/run grant consumption,
  final-boundary grant rechecks, escalation deduplication, pause/reject
  expiration, supervisor fencing, paused-job draining, export-isolation, and
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
- `git diff --check` - passed
- compatibility-only old-name scan - passed

Known inherited quality debt:

- repo-wide `npm run format:check` flags 367 files;
- full dependency audit reports 11 advisories, including 2 critical
  development-tree advisories; and
- production-only audit reports 5 advisories: 1 low, 1 moderate, 3 high,
  0 critical.

Do not use `npm audit fix --force` or format the entire repository as an
incidental part of W7. Track those cleanups separately in the backlog.

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

Expected status after the W7.3 commit: clean. Stop if the active folder is
`D:\projects\taskloom`, the foundation commit is absent, or unrelated changes
appear unexpectedly.
