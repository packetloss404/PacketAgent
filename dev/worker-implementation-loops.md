# PacketAgent implementation loops

Status: canonical execution map for W2-W10 and the inherited backlog.

Last updated: 2026-07-27.

[`../BACKLOG.md`](../BACKLOG.md) remains the status ledger and source of gate
truth. This document supplies the dependency order, implementation slices,
repository seams, verification, and stop conditions needed to execute that
ledger without rebuilding the plan after every loop.

## Scope and authority

- W1-W5 are complete. W1's decisions and verification live in
  [`worker-contract-plan.md`](worker-contract-plan.md).
- W6-W10 are the active autonomous-Worker sequence.
- R1-R8 below are the ordered continuation of the inherited backlog after W10.
- Work explicitly marked "Later, not MVP" is decision-gated and is not part of
  the automatic queue.
- `docs/PHASE3_SCOPE.md`, `docs/HANDOFF.md`, `REPO_REVIEW.md`,
  `REPO_REVIEW_NOTES.md`, and `docs/AGENT_PLAYBOOK_SPRINTS.md` are historical
  evidence. Their unfinished findings are mapped here, but their old phase,
  track, and sprint ordering does not regain authority.
- There is no active D1/D2/D3 sequence. "Track D" means the archived agent-path
  track and is reconciled below.

## Autonomous execution protocol

When a loop is active:

1. Read its backlog gate and every slice in this file.
2. Confirm the working tree contains only expected work and that the current
   branch descends from foundation commit `d60cd47`.
3. Implement the next dependency-ready slice. Preserve existing agent,
   scheduler, webhook, alert, tool, storage, and operations behavior unless the
   slice explicitly migrates an entry point.
4. Run focused deterministic tests after each slice. Add JSON, SQLite, and
   managed-Postgres parity coverage whenever a persisted record or atomic
   command changes.
5. Commit a reviewable slice or tightly coupled pair of slices. Do not combine
   unrelated inherited cleanup with a Worker loop.
6. Run the full loop gate. If it passes, update `BACKLOG.md`,
   `dev/roadmap.md`, `dev/CODEX-HANDOFF.md`, public truth in `README.md`, and
   shipped history in `CHANGELOG.md`; commit the gate; then continue to the
   next loop.
7. Never push to `taskloom-source`. A PacketAgent `origin` must be created and
   confirmed separately before any push.

Continue through normal implementation uncertainty. Stop and request a product
or operator decision only when:

- a public contract has two materially different, irreversible meanings;
- a migration could destroy or reinterpret existing user data and a
  non-destructive forward path cannot be proven;
- required external credentials, endpoints, infrastructure, or another Packet
  product contract do not exist;
- unexpected unrelated worktree changes overlap the active files; or
- a security invariant cannot be satisfied without expanding product scope.

An unavailable external PacketChat or PacketPhone instance does not block local
adapter, contract, replay, and authentication tests. It blocks only the live
interoperability gate.

## Invariants for every slice

- A Worker is bounded by elapsed time, iterations, provider cost, consecutive
  failures, tool calls, retry attempts, and explicit exit predicates.
- Authorization is enforced immediately before each tool or external action,
  not inferred from launch-time UI state.
- Secret values never enter Worker packages, events, logs, checkpoints,
  evidence, approval payloads, or content digests.
- A run stays pinned to one immutable Worker version for its full lifetime.
- Durable writes use optimistic concurrency or a transaction. A read followed
  by an unguarded write is not an acceptable lifecycle operation.
- Duplicate commands and deliveries return the original durable result.
- An uncertain mutating external effect is quarantined; it is never guessed to
  be safe to replay.
- Cancellation, revoke, budget exhaustion, and lease loss are checked at every
  phase and before every tool call.
- New persisted data is workspace-scoped and additive migrations are preferred.
- API and UI claims advance only when the corresponding backlog gate passes.

## Research decisions

The implementation order follows these conclusions:

- The current managed-Postgres backend stores one normalized
  `PacketAgentData` document transactionally. W2 should use that async store
  boundary rather than inventing a second managed-Postgres subsystem. SQLite
  can use dedicated indexed tables while JSON and managed Postgres use the same
  repository contract.
- Database uniqueness, not an in-memory map, must arbitrate version numbers,
  idempotency keys, activation delivery keys, event sequence numbers, and
  checkpoint sequence numbers. PostgreSQL unique constraints and transactional
  isolation are the reference semantics; JSON and SQLite must emulate the same
  observable conflicts.
- An activation envelope follows CloudEvents' useful identity split:
  `source + deliveryId` identifies a delivered occurrence, while Worker,
  deployment, and trigger identifiers select the consumer. A legitimate later
  occurrence receives a new delivery ID.
- Checkpoints are immutable, append-only snapshots. Recovery resumes the same
  pinned version and cursor; changing code or policy requires a new run.
- Every external write uses a prepare/complete effect receipt. A crash after
  preparation but before a recorded completion requires tool-specific
  reconciliation or quarantine.
- Worker events keep OpenTelemetry-compatible trace/span context and stable
  parentage, but the durable event journal remains usable without an external
  telemetry collector.
- Network permissions validate schemes, hosts, resolved IPv4 and IPv6
  addresses, redirects, and the final connected address. Hostname string
  allowlisting alone does not satisfy the W6 gate.

Primary references:

- [CloudEvents specification](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)
- [OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- [PostgreSQL constraints](https://www.postgresql.org/docs/current/ddl-constraints.html)
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Azure Durable Functions overview](https://learn.microsoft.com/en-us/azure/durable-task/durable-functions/durable-functions-overview)
- [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)

## Dependency order

```text
W1 complete
  -> W2 persistence
  -> W3 activation envelope
  -> W4 bounded supervisor
       -> W5 checkpoint/effect safety
       -> W6 permission/budget enforcement
            -> W7 attention/kill controls
                 -> W8 observability
                 -> W9 PacketADE handoff
                      -> W10 PacketChat/PacketPhone
                           -> R1-R8 inherited queue
```

W5 and W6 are separate concerns but should execute in that order so the W6
runtime enforcer can persist its approvals, budget ledger entries, and effect
decisions through the W5 durability boundary. W9 package-schema work may begin
earlier, but its gate waits for W7.

## W2 - Worker persistence, versioning, and activation

Outcome: every W1 record can be stored, and definition/version/deployment
lifecycle commands are atomic, idempotent, and conflict-safe in JSON, SQLite,
and managed Postgres.

### W2.1 - Register the durable data shape

- Add normalized collections for definitions, versions, deployments, runs, and
  checkpoints to `PacketAgentData`, store normalization, seed data, workspace
  record typing, and store export/import behavior.
- Add support records for lifecycle command receipts and an append-only Worker
  event journal. These records carry keys and references, never secret values.
- Add an additive SQLite migration after `0018_sandbox_execs.sql` with
  workspace-aware primary/foreign keys, unique version numbering, deployment
  revision checks, idempotency-key uniqueness, event sequencing, and indexes
  for current-version and deployment-status reads.
- Update `src/store/dedicated-tables.ts` and dual-write/backfill helpers only
  where the SQLite architecture requires them. Do not drop populated tables.

Primary seams: `src/store/types.ts`, `src/store/normalize.ts`,
`src/store/seed.ts`, `src/store/dedicated-tables.ts`, `src/store/dual-write.ts`,
`src/db/migrations/`, and `src/db/cli.ts`.

Verify: old JSON documents normalize with empty Worker collections; migration
up/down safety is replaced by forward-only backup/restore checks; foreign-key
and integrity checks pass.

### W2.2 - Add one async repository contract

- Create a Worker repository under `src/workers/` with workspace-scoped reads
  and atomic command methods. Do not expose unrestricted upserts for lifecycle
  records.
- Use the existing async PacketAgent store transaction for JSON and managed
  Postgres. Use dedicated SQLite statements and transactions when SQLite is
  selected.
- Return typed `not_found`, `conflict`, `invalid_transition`,
  `idempotency_mismatch`, and `integrity` errors consistently across backends.
- Compare optimistic revisions inside the same transaction that writes the new
  state, command receipt, and lifecycle event.

Verify: a shared repository contract suite runs against JSON, SQLite, and a
managed-Postgres transaction client; cross-workspace reads and writes fail.

### W2.3 - Implement lifecycle commands

- Implement create definition, create draft version, update draft, validate
  version, reject version, create deployment, deploy, activate, pause, resume,
  retire, rollback, and definition retirement.
- Recompute the canonical content digest at validation and on every later read.
  Only validated versions can deploy; any digest drift is an integrity failure.
- Keep a deployment pinned to one Worker version. An update or rollback creates
  a new deployment record pinned to the chosen immutable version, records the
  predecessor/successor relationship in an additive rollout record, and
  explicitly retires or pauses the prior rollout.
- Make command idempotency bind the caller key to operation, workspace, target,
  actor, and canonical request digest. Key reuse with different input conflicts.
- Emit the lifecycle event in the same durable operation as the state change.

Primary seams: `src/workers/transitions.ts`,
`src/workers/validation.ts`, new `src/workers/repository.ts`,
`src/workers/service.ts`, `src/workers/errors.ts`, and
`src/workers/events.ts`.

Verify: transition tables, immutable content, replay, stale revision, rollback,
and two-writer activation races.

### W2.4 - Expose private lifecycle routes

- Add workspace-authenticated Hono routes for Worker definitions, versions, and
  deployments. View operations require viewer access; draft mutation requires
  member access; activation and retirement require admin access.
- Require an idempotency key on lifecycle writes and an expected revision on
  updates.
- Return stable conflict codes and redacted validation paths. Do not expose
  webhook tokens or credential values.
- Mount a dedicated route module from `src/server.ts`; do not add another block
  of inline server handlers.

Verify: route auth/RBAC, request validation, idempotent response replay, stale
revision, tenant isolation, and redaction tests.

### W2.5 - Close the parity gate

- Run the same lifecycle scenario in all three store modes, including
  concurrent activation, rollback to an older version, process reload, and
  import/export.
- Confirm the legacy agent/workflow projections remain read-only drafts and
  current APIs return unchanged shapes.
- Add W2 manual smoke steps to `dev/TESTING.md`.

Gate: the W2 gate in `BACKLOG.md` passes with no backend-specific lifecycle
behavior.

## W3 - Trigger and activation envelope

Outcome: manual, cron, webhook, alert, and queue deliveries enter one durable,
deduplicated activation path.

Status: complete. Gate passed 2026-07-27.

### W3.1 - Define the envelope and inbox records

- Add a versioned `WorkerActivationEnvelope` containing activation ID, source,
  delivery ID, occurred/received timestamps, actor, workspace, deployment,
  Worker version, trigger ID/kind, payload or payload reference, and trace
  context.
- Add an activation inbox record with request digest, disposition, run ID,
  first/last seen timestamps, and duplicate count.
- Validate payloads against the Worker's input schema before a run is created.
  Store large or sensitive payloads by reference under an explicit retention
  policy.

Verify: schema, canonical digest, sensitive-field, and distinct-occurrence
tests.

### W3.2 - Implement atomic intake

- In one transaction, validate the active deployment and enabled trigger,
  reserve the delivery key, create a queued run pinned to the deployment
  version, append an event, and enqueue the execution job.
- Use `(workspace, deployment, trigger, source, deliveryId)` as the dedupe
  boundary. A duplicate returns the first intake result and run ID.
- Treat a reused delivery key with a different request digest as an integrity
  conflict.

Primary seams: new `src/workers/activation.ts` and
`src/workers/activation-repository.ts`, `src/jobs/store.ts`, and the W2
repository transaction boundary.

Verify: two-process concurrency, transaction rollback, queue-write failure, and
duplicate-vs-legitimate-repeat tests.

### W3.3 - Adapt every current entry point

- Manual: add a deployment-run action through the common intake service.
- Cron: project active cron triggers into persistent scheduled jobs without
  mutating the legacy agent schedule path.
- Webhook: add opaque Worker webhook references and route them through intake;
  retain existing agent webhook compatibility.
- Alert: adapt alert events after their existing durable alert record exists.
- Queue: treat the persistent jobs queue as the first queue adapter and preserve
  an upstream message ID when one is supplied.
- Carry W3C trace context when valid and start a new trace when absent.

Primary seams: `src/jobs/scheduler.ts`, `src/jobs/store.ts`,
`src/webhook-routes.ts`, `src/alerts/`, and new Worker route/adapter modules.

### W3.4 - Close the delivery gate

- Crash-inject before and after inbox reservation, run creation, and job
  enqueue.
- Replay every adapter and race multiple deliveries with the same key.
- Add manual cron/webhook/alert/queue cases to `dev/TESTING.md`.

Gate: every delivery starts at most one run and no committed intake loses its
execution job.

## W4 - Bounded autonomous supervisor

Outcome: a queued Worker run executes a deterministic
plan-act-evaluate-checkpoint-decide state machine and cannot exceed its bounds.

Status: complete. Gate passed 2026-07-27 with finite adversarial bounds,
fenced lease/revision tests, scheduler shutdown release coverage, and runtime
persistence parity across JSON, SQLite, and managed Postgres.

### W4.1 - Isolate runtime ports

- Define narrow provider, tool, clock, checkpoint, event, lease, and
  cancellation ports under `src/workers/runtime/`.
- Adapt `ProviderRouter`, `ToolRegistry`, and `runAgentLoop` behavior behind
  those ports; do not let the supervisor depend on Hono, React, or a concrete
  store.
- Make provider usage and tool results explicit values returned to the
  supervisor.

### W4.2 - Implement the phase reducer

- Implement pure phase transitions for plan, act, evaluate, checkpoint, decide,
  and attention.
- Require at least one exit predicate. Evaluation records which predicate was
  tested, its evidence, and its result.
- Only the reducer selects completed, failed, budget-exhausted, cancelled, or
  quarantined terminal reasons.
- Emit a monotonic phase/action cursor through the checkpoint port so a phase
  can be retried without advancing twice. W5 makes the full snapshots and
  restart recovery durable.

### W4.3 - Enforce all run bounds

- Use a monotonic clock for elapsed execution and persisted timestamps for
  recovery.
- Charge provider cost after every call and tool-call count before execution.
- Count consecutive failures, reset only after a successful phase, and apply
  bounded retry/backoff from the pinned policy.
- Check elapsed, iteration, cost, failure, tool, cancellation, revoke, and
  lease state before and after every await boundary.

### W4.4 - Add execution jobs and leases

- Register a `worker.run` job handler in the existing scheduler.
- Acquire a workspace/run-scoped lease with owner, expiry, and fencing token.
  Renew it during execution and stop on lease loss.
- Bind job cancellation to the supervisor abort signal. A scheduler shutdown
  releases work for safe recovery rather than marking success.
- Persist run transitions and events with optimistic revision checks.

Primary seams: `src/tools/agent-loop.ts`, `src/tools/executor.ts`,
`src/providers/router.ts`, `src/jobs/scheduler.ts`, `src/jobs/store.ts`, and new
`src/workers/runtime/` modules.

### W4.5 - Close the boundedness gate

- Use fake clocks and scripted providers/tools to test endless tool requests,
  hung calls, repeated failures, cost overruns, cancellation at every phase,
  lease theft, and invalid exit output.
- Assert a finite upper bound on provider and tool calls for every scenario.

Gate: adversarial tests cannot produce an unbounded or post-cancellation run.

## W5 - Checkpoint, recovery, and side-effect safety

Outcome: a process can crash at any phase and resume without losing progress or
duplicating a completed external effect.

Status: complete. Gate passed 2026-07-27 with digest-chained full snapshots,
prepared/completed effect receipts, restart reconciliation, unsafe-replay
quarantine, crash injection, and JSON/SQLite/managed-Postgres parity.

### W5.1 - Persist immutable checkpoints

- Append checkpoints with run/version IDs, sequence, phase cursor, working
  memory, completed action IDs, pending approvals, artifact refs, effect
  receipt IDs, remaining budgets, trace context, and creation time.
- Atomically append the checkpoint and advance `WorkerRun.latestCheckpointId`
  with expected-run revision and expected checkpoint sequence.
- Validate that budget remaining never increases and the checkpoint version
  matches the run's pinned version.

### W5.2 - Add effect receipts at the tool boundary

- Classify tools as read-only, idempotent mutation, reconcilable mutation, or
  non-replayable mutation.
- Derive an effect key from run, iteration, action ID, capability ID, tool
  operation, and canonical input digest.
- Persist `prepared` before the external call and `completed` with a redacted
  result reference after it. A completed receipt returns the prior result.
- On recovery from `prepared`, invoke a tool-specific reconciliation hook. If
  the effect cannot be proven absent or completed, quarantine the run.
- Never hold a database transaction open across a network or process call.

Primary seams: `src/tools/types.ts`, `src/tools/executor.ts`, each mutating tool
adapter, and new `src/workers/effects.ts`.

### W5.3 - Recover expired work

- On scheduler startup and periodic reconciliation, find nonterminal runs with
  expired leases.
- Resume from the latest valid checkpoint with the same version, policy,
  remaining budget, trace, and effect receipts.
- Quarantine corrupt checkpoint chains, digest mismatches, missing versions,
  impossible cursors, and uncertain effects.
- Make recovery itself idempotent under multiple scheduler leaders.

### W5.4 - Close the crash matrix

- Inject crashes before/after every durable write, provider call, tool prepare,
  external effect, tool completion, checkpoint, and terminal transition.
- Use fake mutating adapters that count real effects independently from
  receipts.
- Restart against JSON, SQLite, and managed Postgres for the parity scenarios.

Gate: recovery neither repeats a completed effect nor silently abandons a
committed nonterminal run.

## W6 - Permission and budget policy

Outcome: the W1 policy becomes an enforceable, deny-by-default runtime boundary
for every provider, tool, credential, network, filesystem, shell, and external
write action.

Status: active. W6.1 is complete; resume at W6.2.

### W6.1 - Compile typed capabilities

Status: complete. Version validation now rejects unknown tools/verbs, unsafe
wildcards, non-HTTP network schemes, relative filesystem escapes, raw
credential values, effect mismatches, and contradictory overlaps. Deployment
grants can only narrow the requested upper bound, and the resulting normalized
tuples are persisted with a deterministic policy digest tied to the immutable
Worker version digest.

- Parse each Worker tool capability into a normalized tuple of tool, verb,
  resource, effect, and approval requirement.
- Reject unknown verbs, ambiguous wildcards, overlapping contradictory grants,
  relative filesystem escapes, non-HTTP network schemes, and credentials not
  declared by reference.
- Produce a compiled policy tied to the Worker version digest. Requested
  capabilities are an upper bound; deployment grants may only narrow them.

### W6.2 - Enforce immediately before execution

- Extend `ToolContext` with run, deployment, version, capability, budget,
  effect, and actor context.
- Put one mandatory policy-enforcement call in `executeTool` before the handler
  receives input. Direct handler tests remain possible, but production
  registration cannot bypass the executor.
- Make adapters expose a normalized operation before authorization: HTTP
  method/URL, GitHub verb/resource, SQL mode/database, filesystem path, shell
  command target, message destination, or email recipient scope.
- Record allow/deny decisions as redacted Worker events.

### W6.3 - Resolve secrets and harden process/network boundaries

- Add a workspace-scoped credential resolver for opaque credential references;
  adapt the existing encrypted API-key vault and add other credential kinds
  without returning values to callers.
- Resolve a secret only after policy approval and immediately before the call.
  Scrub child-process environments to an allowlist.
- Deny network by default. Validate protocol, redirects, A/AAAA resolution,
  public/private ranges, and the connected address to resist SSRF and DNS
  rebinding.
- Worker shell/code execution requires an isolated sandbox driver, resource
  limits, and explicit network policy. The insecure native fallback is not
  accepted for autonomous Worker execution.

This slice absorbs the security work from archived Track E that directly
blocks the Worker permission gate. Generated-app sandbox defaulting and preview
origin isolation remain in R5.

### W6.4 - Add per-run and rolling budgets

- Keep W4's per-run counters authoritative.
- Add workspace/deployment rolling windows for provider cost and externally
  billable actions with atomic reserve/settle/release entries.
- Refuse a provider or tool call when either the run budget or rolling budget
  cannot reserve its maximum expected charge.
- Reconcile abandoned reservations after lease expiry without double credit.

### W6.5 - Close the bypass gate

- Test calls made through every registered tool, direct registry access,
  redirects, alternate IP notation, DNS changes, path links/case aliases,
  command arguments, credential mismatch, stale compiled policy, and concurrent
  cost reservations.
- Assert denial occurs before credentials resolve or an effect receipt prepares.

Gate: no registered runtime path can perform an undeclared action or exceed a
committed budget.

## W7 - Attention, approval, and kill controls

Outcome: approvals and operator commands are durable, independently available,
audited, and safe across restarts and replay.

### W7.1 - Add durable control records

- Define and persist attention requests, approval grants, control commands, and
  notification delivery references.
- Bind each approval to workspace, deployment, run, version digest, capability,
  normalized operation digest, scope (`once` or `run`), actor, expiry, and
  nonce.
- Keep command and approval consumption durable; replace the in-memory consumed
  token map for Worker runs.

### W7.2 - Implement the control service

- Add pause, resume, stop, revoke, approve once, approve for run, and reject.
- Pause/stop/revoke updates durable desired state first; running supervisors
  observe it before further action.
- Revoke blocks future activation and stops active runs. Stop affects one run.
  Pause preserves the checkpoint and remaining budget.
- Use expected revisions and idempotency keys for every command.

### W7.3 - Integrate supervisor attention

- A missing required approval creates an attention request, checkpoints, emits
  an event, and transitions to `waiting_for_approval`.
- Approval resumes only if the version, operation, policy, expiry, and pending
  request still match.
- Escalation deadlines enqueue notification work once; expiration follows the
  declared reject/pause policy and never silently approves.

### W7.4 - Add independent operator APIs

- Mount Worker control routes outside the Builder route module.
- Apply RBAC separately to inspect, run control, deployment control, and
  approvals. W7 is the first public revoke operation because it also stops
  active work and blocks future activation.
- Return concise state suitable for another Packet product or a command-line
  client.

### W7.5 - Close the restart/kill gate

- Restart while waiting for approval, replay approval callbacks, race
  approve/reject, stop during each supervisor phase, and revoke while new
  activations arrive.
- Verify control remains possible with the originating Builder or PacketADE
  process closed.

Gate: an authorized operator can always stop a run and revoke future activation
without relying on the authoring UI.

## W8 - Worker observability, cost, and evidence

Outcome: one API and one UI surface answer what is running, why, at what cost,
from which version, at which checkpoint, and what needs attention.

### W8.1 - Formalize the event and evidence model

- Version Worker event envelopes and assign monotonic sequence within a
  deployment/run stream.
- Correlate activation, queue, supervisor, provider, tool, effect, approval,
  checkpoint, control, and terminal events with trace/span IDs.
- Define evidence entries, artifact manifests, content digests, provenance, and
  redaction classification.
- Keep raw payloads optional and separately retained; summaries and hashes must
  remain useful after raw retention expires.

### W8.2 - Build deterministic rollups

- Roll provider calls, tool calls, effects, retries, queue duration, approvals,
  checkpoints, budget usage, artifacts, and outcomes up by Worker version and
  deployment.
- Reuse `providerCalls`, job metrics, activities, existing agent traces, and
  redaction utilities through adapters rather than copying their storage.
- Make rollups rebuildable from the durable journal and source records.

Primary seams: `src/providers/ledger.ts`, `src/provider-calls-read.ts`,
`src/agent-run-trace.ts`, `src/services/activities.ts`, `src/operations-*`, and
new `src/workers/observability/` modules.

### W8.3 - Add retention and redaction

- Define separate retention windows for metadata, summaries, prompts, tool
  inputs/outputs, and artifacts.
- Redact sensitive keys and known secret values before persistence and again at
  the API boundary.
- Record deletion/tombstone events so evidence gaps are explained.
- Add bounded cleanup jobs with dry-run metrics and tenant scoping.

### W8.4 - Expose API and UI

- Add list/detail/health/attention/evidence/event endpoints with cursor
  pagination and stable filters.
- Add Worker list and detail views under the existing Runs/Operations
  information architecture. Show deployment/version, live state, budget,
  checkpoint, attention, evidence timeline, artifacts, and control actions.
- Use SSE for live events with cursor resume; polling remains a fallback.

### W8.5 - Close the answerability gate

- Test rollup rebuilds, missing source records, redaction, retention, cursor
  reconnect, tenant isolation, and accessible UI loading/error/empty states.
- Add screenshots/manual cases to `dev/TESTING.md`.

Gate: the required health and evidence answers come from the read model without
client-side joins over raw tables.

## W9 - PacketADE deployment handoff

Outcome: PacketADE can validate, deploy, activate, close, reconnect, inspect,
update, pause, roll back, and revoke a Worker through a versioned contract.

### W9.1 - Freeze WorkerPackage v1

- Replace the illustrative TypeScript block in
  `dev/packetade-packetagent-handoff.md` with the exact versioned schema and
  checked examples.
- Align objective, instructions, input schema, execution route/target, typed
  capabilities, credential references, triggers, policies, exit predicates,
  acceptance commands, notifications, artifacts, and W1 provenance.
- Define canonical package digest bytes. Digest verification is mandatory;
  signatures are verified when the trust relationship requires them.
- Add compatibility fixtures and reject unknown major schema versions.

### W9.2 - Add the Packet-product trust boundary

- Authenticate PacketADE service requests and bind them to an allowed
  PacketAgent workspace and actor.
- Keep package capability requests as an upper bound requiring local policy
  acceptance.
- Store package ID/version, integrity result, provenance, and idempotency
  receipt before activation.
- Rate-limit and audit all package and control writes without logging tokens.

### W9.3 - Implement the deployment endpoints

- Implement validate, deploy, update, activate, inspect, list runs, pause,
  resume, rollback, and revoke through W2/W3/W7 services.
- Never duplicate lifecycle logic in the route layer.
- Support dry-run validation and return field-addressed errors, required local
  approvals, granted/narrowed capabilities, and resulting IDs.

Primary seams: new `src/workers/package/` and `src/worker-package-routes.ts`,
`src/server.ts`, `src/rbac.ts`, and the Packet product credential store.

### W9.4 - Stream reconnectable events

- Project W8 events to the versioned PacketADE event contract.
- Support cursor/`Last-Event-ID` resume, heartbeat, retention-bound cursor
  errors, and at-least-once delivery with stable event IDs.
- Require idempotent acknowledgements or cursor advancement; never make an SSE
  connection the source of durability.

### W9.5 - Close the handoff gate

- Run contract tests from serialized PacketADE fixtures through validate,
  deploy, activate, disconnect, process restart, reconnect, inspect, update,
  rollback, pause, and revoke.
- Add a real cross-product interoperability test when a PacketADE endpoint and
  credentials are available.

Gate: closing PacketADE does not affect the deployment, run, evidence, or later
reconnection.

## W10 - PacketChat and PacketPhone routes

Outcome: Worker summaries, attention, approval, and kill controls reach remote
Packet surfaces without weakening W7 policy or audit guarantees.

### W10.1 - Add a notification outbox

- Define a versioned, channel-neutral notification envelope for attention,
  progress summaries, and terminal outcomes.
- Persist an outbox item and source Worker event atomically; deliver with
  bounded retry, idempotency key, expiry, and dead-letter state.
- Store notification route references and redacted delivery metadata, never
  endpoint secrets.

### W10.2 - Implement PacketChat delivery

- Send concise deployment/run/version state, reason, budget, checkpoint,
  evidence link, and required action.
- Thread updates by deployment/run and collapse noisy progress into bounded
  summaries.
- Authenticate callbacks that open or inspect the matching Worker.

### W10.3 - Implement PacketPhone controls

- Deliver approve, reject, pause, stop, and revoke actions only when the actor
  and role permit them.
- Bind signed callback tokens to action, workspace, deployment, run, attention
  request, version digest, actor/audience, nonce, and expiry.
- Consume callbacks durably and reject stale, replayed, cross-workspace, or
  already-resolved actions.

### W10.4 - Close the remote-control gate

- Contract-test Chat and Phone adapters locally with fake endpoints.
- Race local and remote actions, replay callbacks, rotate credentials, restart
  with pending deliveries, and verify dead-letter recovery.
- Run live interoperability tests when PacketChat and PacketPhone endpoints are
  available.

Gate: remote actions preserve exactly the same W7 policy, idempotency, and audit
semantics as local actions.

## R1-R8 - Inherited continuation after W10

These loops turn the remaining active sections of `BACKLOG.md` into an ordered
queue. A direct blocker may be pulled forward into W2-W10 and recorded in both
places. Otherwise, execute these after W10.

| Active backlog section                    | Execution destination                  |
| ----------------------------------------- | -------------------------------------- |
| PA0 formatting, lint, and dependency debt | R1                                     |
| Provider policy                           | R2                                     |
| File-tree codegen                         | R3                                     |
| Generated-app persistence and runtime     | R4 and R5                              |
| Existing agent path                       | W6 and R6                              |
| Sandbox and execution farm                | W6 and R5                              |
| Cross-cutting security                    | W6, R1, and R5                         |
| MVP reliability                           | R7 and R8                              |
| Builder depth                             | R3 and R7                              |
| Agent depth                               | R6                                     |
| Self-host publish                         | R4                                     |
| Quality bar and portfolio audit           | R1, R7, and R8                         |
| Later, not MVP                            | Decision-gated; no automatic execution |

### R1 - Repository health and historical finding re-audit

1. Re-run every still-relevant finding from `REPO_REVIEW.md` against current
   code; close stale items with evidence instead of copying old line numbers.
2. Finish the repo-wide Prettier baseline in reviewable directory batches and
   reduce the inherited ESLint warnings to zero.
3. Triage dependency advisories without force-upgrade churn.
4. Close verified correctness items: JSON write serialization, migration
   backup/foreign-key integrity, jobs single-writer/workspace scoping, managed
   pool reuse, and managed backfill preservation.
5. Close verified app/security quick wins: production startup truth,
   ErrorBoundary, iframe sandboxing, corrupt-row handling, complete secret
   redaction, dead controls, button types, explicit bootstrap, rate-limit
   identity, headers/CSP, and artifact scoping.
6. Decide and document the persistence end-state before deleting compatibility
   facades. Refactors must preserve all three supported modes until that
   decision is explicit.

Gate: every historical P0/P1 finding is either fixed, proven stale, or linked
to a named later loop; CI/test/build truth and migration recovery are green.

### R2 - Provider policy and key parity

1. Add per-provider generation policy and capability metadata.
2. Add vLLM structured decoding/XGrammar with tested fallback.
3. Add one bounded malformed-tool-input correction attempt.
4. Add Gemini and OpenRouter vault-key parity.
5. Consolidate model/provider catalogs and readiness reporting.

Gate: every supported provider follows one tested policy contract and every
hosted provider key can be stored and resolved through the vault.

### R3 - File-tree generation depth

1. Collect real failure clusters and add targeted, bounded repair prompts.
2. Move legacy-template iteration onto the file-tree path or provide a
   deterministic one-time conversion.
3. Stream per-file plan/write/validate progress to the Files view.
4. Add file-level changed/unchanged/new/deleted review and targeted
   route/entity/component regeneration.
5. Add sandboxed package-install planning and workspace export as zip or
   git-ready files.

Gate: both new and legacy drafts use one file-tree source of truth and users can
review, repair, target, and export changes without hidden mutation.

### R4 - Generated-app runtime and self-host publish

1. Add per-app runtime health, metrics, crash visibility, and documented
   process-pool limits.
2. Add health endpoints, static-asset manifest validation, and signed/checksum
   artifact manifests.
3. Turn publish handoff into a verified local Docker Compose run path.
4. Add reverse-proxy/VPN examples and a public-URL reachability check.
5. Preserve schema/data migration truth; do not imply automatic migration when
   a schema reset is still the behavior.

Gate: an exported app can be integrity-checked, started, health-checked, and
reached through the documented self-host path.

### R5 - Sandbox, egress, and preview isolation

1. Make real sandboxed `tsc` and Vite validation the default; remove synthetic
   success.
2. Default to a fail-closed isolated driver for untrusted code and define the
   supported non-Docker fallback. Remove `node:vm` as a security boundary.
3. Enforce CPU, memory, process, timeout, filesystem, environment, and egress
   limits at the sandbox boundary.
4. Reuse W6 network protections for redirects, SSRF, IPv4/IPv6, and DNS
   rebinding.
5. Serve generated previews on an isolated origin with appropriately scoped
   cookies, CSP, and proxy rules.
6. Harden container execution with a non-root user, dropped capabilities,
   no-new-privileges, and process limits.

Gate: untrusted generated code cannot inherit host secrets/session cookies,
reach undeclared networks, or escape declared resource limits.

### R6 - Agent authoring and execution depth

1. Wire the default SMTP transport through the vault-backed credential path.
2. Add LLM-authored Worker/agent templates beyond the heuristic draft builder.
3. Show provider/model/key/capability readiness before first run.
4. Add editable memory and input-schema examples plus first-run evaluation.
5. Add signed, versioned agent/Worker import and export.
6. Consolidate legacy agent execution onto the canonical Worker lifecycle only
   after compatibility and migration tests prove no API regression.

Gate: an authored agent can be evaluated, exported/imported, and operated as a
canonical Worker without losing legacy compatibility.

### R7 - Builder and frontend maintainability

1. Split remaining god views and route modules along established feature seams.
2. Add shared accessible loading/error/empty boundaries and keyboard-safe
   interactive primitives.
3. Remove duplicated client data-fetch/format utilities after characterization
   tests.
4. Make the styling direction explicit and migrate incrementally without a
   repo-wide visual rewrite.
5. Add stable component/browser coverage for Builder app and Worker modes.

Gate: critical authoring and operations views have accessible state handling,
bounded module ownership, and regression coverage.

### R8 - Release reliability and production packaging

1. Persist smoke-test transcripts per generated app checkpoint.
2. Add focused app and Worker happy paths: sign in, build, approve, run,
   inspect, iterate, publish or deploy, reconnect, and stop.
3. Add regression tests for path traversal, preview serving, artifact
   validation, rollback, backup/restore, and tenant isolation.
4. Build production JavaScript artifacts and run plain Node in the production
   image if the packaging spike proves it improves the self-host path without
   breaking source maps or optional Playwright.
5. Search release surfaces for placeholders, fake success, demo-only text, and
   unsupported "coming soon" claims.
6. Keep generated artifacts out of Git and document cleanup/reset.

Gate: the release checklist, production image, backup round-trip, automated
happy paths, and public claims describe the same tested product.

## Decision-gated work

Do not automatically start these after R8:

- hosted PacketAgent Cloud;
- collaborative multiplayer editing;
- marketplace templates or shared plugins;
- a full browser IDE;
- multi-region active-active runtime;
- distributed SQLite or custom replication;
- visual direct-DOM editing;
- conversation forking/shareable hosted build URLs; or
- any hosted-only item inventoried in `CLOUD.md`.

Starting one changes product scope, operating cost, or trust boundaries and
requires an explicit owner decision.

## Historical plan reconciliation

| Historical source                   | Current disposition                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 3 Track A, BYOK               | Core router/adapters shipped; remaining provider policy, structured decoding, correction retry, and vault parity are R2.                          |
| Phase 3 Track B, file tree          | Core authoring, validation, projection, iteration, and bounded repair shipped; remaining work is R3.                                              |
| Phase 3 Track C, app runtime        | Per-app SQLite/runtime shipped; health, publish integrity, and preview isolation are R4/R5.                                                       |
| Phase 3 Track D, agent path         | Six tools, approval UX, Builder parity, and trace view shipped; resource-scoped enforcement is W6, SMTP/template/evaluation/import-export are R6. |
| Phase 3 Track E and Security        | Worker-bound capability, credential, environment, egress, and sandbox enforcement is W6; generated-code sandboxing and preview isolation are R5.  |
| Repo Review Phase 1                 | Many foundation items shipped; all claims are re-audited and remaining correctness/security work closes in R1/R5/R8.                              |
| Repo Review Phase 2                 | Lint/format/docs work began in PA0; baseline closure and configuration cleanup are R1.                                                            |
| Repo Review Phase 3                 | Persistence end-state and module decomposition require current evidence; they are R1/R7, not license for a rewrite.                               |
| Repo Review Phase 4                 | Runtime policy blockers are W6; remaining production/container/backup/e2e work is R1/R5/R8.                                                       |
| Agent playbook sprints              | Historical feature plan is substantially shipped; Worker observability/control integration continues in W7/W8/R6.                                 |
| High-numbered `PhaseNN` code labels | Historical implementation labels only. Re-audit in R1 before renaming or deleting; they do not create roadmap work by themselves.                 |

## Verification matrix

Every slice:

```powershell
npm run typecheck
npx prettier --check <changed-files>
npx eslint <changed-code-files>
git diff --check
```

Every backend or migration slice:

```powershell
npm run test:api
$env:PACKETAGENT_STORE = "sqlite"
npm run db:migrate
npm run db:status
```

Every UI slice:

```powershell
npm run test:web
npm run build:web
```

Every completed W or R loop:

```powershell
npm run typecheck
npm run lint
npm run build:web
npm run test:api
npm run test:web
git diff --check
```

Repo-wide `npm run format:check` becomes mandatory after R1 closes its inherited
baseline. Until then, all authored and touched files must pass Prettier.
