# Manual Test Plan

End-to-end test plan run before cutting a release. Covers the builder loop, agent loop, workspace setup, providers, sandbox, operations, self-host publish handoff, and the backup round-trip.

This plan verifies the inherited workbench plus W2's durable Worker lifecycle,
W3's trigger-intake boundary, W4's bounded supervisor, W5's checkpoint,
recovery, and effect-safety boundary, W6.1's capability compilation, W6.2's
immediate runtime policy enforcement, W6.3's credential/network/process
hardening, W6.4's atomic rolling budgets, W6.5's adversarial bypass gate, and
W7.1's durable control records plus W7.2's atomic control service. Supervisor
attention and deadline enforcement are covered by W7.3. Independent operator
API coverage is added by W7.4, and W7.5 closes the restart/kill gate.
W8.1 adds the versioned event, evidence, and artifact-provenance substrate.
W8.2 adds deterministic cumulative version/deployment/run rollups. W8.3 adds
bounded redaction, retention, and deletion evidence. W8.4 adds the consolidated
Worker health/list/detail read model, filter-bound cursor APIs, bounded
resumable event stream, and canonical Worker workbench. W8.5 closes one-read
answerability, source-order/backend parity, tenant-bound cursors, accessible
loading/error/empty states, and the documented screenshot/manual matrix.
W9.1 adds the checked WorkerPackage v1 contract fixtures and integrity cases.
W9.2 adds workspace/actor/operation-bound PacketADE credentials, local
capability acceptance, durable pre-deployment receipts, rate limiting,
token-safe audit, and three-backend parity. W9.3 adds receipt-bound
deployment/control routes, and W9.4 adds reconnectable event streams plus
durable cursor acknowledgement. The serialized disconnect/process-restart
gate passes in W9.5. W10.1 adds the channel-neutral notification
outbox, atomic event/evidence binding, stable idempotency, bounded
retry/expiry/dead-letter handling, scheduler integration, redaction, and
retention-safe provenance. W10.2 adds encrypted PacketChat route resolution,
pinned-network delivery of bounded threaded cards, stable progress
replacement, and short-lived exact-binding read-only callbacks. W10.3 adds
encrypted HTTPS-only PacketPhone delivery, role-bounded controls, and durable
single-use callbacks through W7. W10.4 closes the local gate across
fake-endpoint contracts, race orderings, credential rotation, restart,
replay, and audited dead-letter redrive. Live interoperability remains
conditionally skipped.

Last automated W10.4 baseline (2026-07-28):

- API: 1,509 passed, 4 skipped, 0 failed
- Web: 28 passed, 0 failed
- Focused production-catalog executor/direct-access guards,
  denial-before-credential/budget/effect/network ordering, linked and
  case-aliased host paths, hostile command arguments, stale/tampered policy,
  atomic rolling-budget concurrency, provider/action reservation ordering,
  idempotent settlement/release, lease-expiry reconciliation, Worker
  credential isolation, A/AAAA and connected-address validation, redirect
  denial, Docker-only execution, capability compilation/narrowing, activation,
  supervisor, checkpoint-chain, effect-replay, atomic control-command races,
  pause/resume/stop/revoke, approval/rejection, nonce non-persistence,
  approval-required checkpointing, exact one-time/run grant consumption,
  final-boundary grant rechecks, escalation deduplication, pause/reject
  expiration, independent operator RBAC, redacted projections, strict mutation
  inputs, no-store first-use approval nonces, workspace isolation,
  fresh-process approval resume, callback replay, both approve/reject and
  activation/revoke race orderings, stop at every supervisor phase, headless
  operator reconstruction, paused-job draining,
  recovery/quarantine, lease/revision, scheduler, and JSON/SQLite/managed-Postgres
  parity checks: passed
- Focused v2 event/evidence pairing, monotonic workspace/deployment/run streams,
  W3C trace validation, durable source correlation, event/evidence tamper
  detection, content/provenance-bound artifact manifests, legacy v1 reads,
  cursor filtering, migration, export isolation, and
  JSON/SQLite/managed-Postgres parity checks: passed
- Focused ordered-source replay, fresh-process rebuild,
  version/deployment/run aggregation, provider/tool/effect calls, job and
  supervisor retries, queue duration, approvals, checkpoints, reported and
  rolling budgets, artifacts, outcomes, exit-predicate matches,
  missing-source gaps, workspace isolation, and stable
  JSON/SQLite/managed-Postgres parity checks: passed
- Focused pre-persistence and read-boundary redaction, known-secret removal,
  separate retention windows, read-only dry runs, item/time bounds, explicit
  workspace scoping, terminal-only run/checkpoint/effect compaction,
  digest-checked artifact deletion, idempotent tombstones,
  retention-explained source gaps, active-run preservation, and
  JSON/SQLite/managed-Postgres parity checks: passed
- Focused one-read Worker identity/state/budget/checkpoint/attention/evidence
  projection, health aggregation, stable and filter-bound run/event cursors,
  cross-workspace cursor rejection, independently authorized routes,
  `Last-Event-ID` SSE resume, duration/event ceilings, and explicit stream
  closure checks: passed
- Focused source-order-independent operations projections,
  JSON/SQLite/managed-Postgres read-model parity, filter- and tenant-bound
  attention cursors, secret-free detail projections, and accessible Worker
  loading/error/empty/ready state semantics: passed
- Focused strict WorkerPackage shape, W1 content/provenance reuse, canonical
  byte and digest reproducibility, property-order independence, Unicode and
  non-JSON rejection, tamper/missing-bound/undeclared-field failures,
  unsupported-major compatibility, DSSE payload binding, and
  required/untrusted signature policy: passed
- Focused PacketADE credential workspace/actor/operation binding, expiry and
  revocation, digest-only token storage, local capability narrowing,
  signature-policy enforcement, pre-deployment receipt idempotency and
  integrity, durable rate-limit/audit outcomes, secret-free export, and
  JSON/SQLite/managed-Postgres parity: passed
- Focused lifecycle-dry validation, field-addressed transport errors,
  authenticated deploy/inspect/list/control, exact activation replay, atomic
  forward update, locally narrowed update/rollback grants, unbound/
  cross-workspace/stale rejection, immutable package/deployment graph,
  migration, export isolation, and JSON/SQLite/managed-Postgres parity: passed
- Focused versioned event projection, progress/approval/completion/failure/
  budget mapping, linked evidence, stable IDs, cursor and `Last-Event-ID`
  resume, bounded SSE heartbeat/close, no-ack streaming, idempotent monotonic
  cursor acknowledgement, ETag conflicts, restart reconstruction,
  stream-bound cursors, retention-window recovery, secret isolation, and
  JSON/SQLite/managed-Postgres parity: passed
- Focused serialized validate/deploy/activate, real SSE abort, token-free
  durable-store round trip, fresh service reconstruction, acknowledged
  reconnect, pinned queued-run/job preservation, evidence resolution, update,
  pause/resume, rollback, revoke, and transition-event projection: passed
- Focused notification event/evidence/outbox/job atomicity and rollback,
  legacy delivery compatibility, stable retry idempotency, bounded attempt
  leases and backoff, expiry, dead-letter state, opaque route references,
  redacted delivery metadata, pending-evidence retention pinning, terminal
  digest tombstones, attention/progress/terminal production paths, scheduler
  registration, and JSON/SQLite/managed-Postgres parity: passed
- Live PacketADE network validation: conditionally skipped because no endpoint,
  workspace, or credential is configured
- Signed-in browser pass for the canonical `/runs` empty state, accessible
  labels and filters, `/activity` preservation and two-way navigation, missing
  Worker detail error state, and console warnings/errors: passed
- Typecheck: passed
- Production web build: passed
- ESLint: 0 errors, 145 inherited warnings

See [`CODEX-HANDOFF.md`](CODEX-HANDOFF.md) for the full repository state.

Estimated time: 25-35 minutes for a full pass; about 10 minutes for the golden path.

## Prerequisites

- Node `>=22.5.0` and npm.
- A running Docker daemon for autonomous Worker command tests. Interactive
  development may opt into the insecure native driver explicitly, but Workers
  must refuse it.
- Clean working tree.

```bash
npm install
npm run store:seed    # default JSON store; creates seed accounts and workspaces
```

When testing SQLite specifically, set `PACKETAGENT_STORE=sqlite`, then run `npm run db:migrate` and `npm run db:seed` before booting the app.

Seed accounts (all password `demo12345`):

| Email                     | Workspace | Role  |
| ------------------------- | --------- | ----- |
| `alpha@packetagent.local` | alpha     | owner |
| `beta@packetagent.local`  | beta      | owner |
| `gamma@packetagent.local` | gamma     | owner |

To wipe state between full passes:

```bash
npm run store:reset    # JSON store at data/packetagent.json
PACKETAGENT_STORE=sqlite npm run db:reset
```

Boot the app:

```bash
npm run dev
```

Open `http://localhost:7341/` in development, or `http://localhost:8484/` after `npm run build:web && npm start`.

## W2 Worker Lifecycle Smoke

Use an authenticated API client for `/api/app/workers`. Browser-originated
mutations must also send the existing PacketAgent CSRF cookie/header pair.

1. As a member, create a definition at `POST /api/app/workers/definitions` with a bounded W1 `content` object, PacketAgent source provenance, and an `Idempotency-Key` header.
2. Replay the identical request with the same key. Confirm the original definition/version IDs return and no duplicate event appears.
3. Validate the version using its `contentDigest`, then create, validate, and deploy a deployment using the returned revision at each step.
4. As an admin, activate, pause, resume, and retire the deployment. Confirm each response increments `revision` exactly once.
5. Create and activate a newer validated version, then roll it back to the older version. Confirm the old deployment retires, a new version-pinned deployment appears, and the rollout links predecessor to successor.
6. Reuse an idempotency key with changed input and submit one stale digest/revision. Confirm stable `idempotency_mismatch` and `conflict` responses.
7. Restart PacketAgent and read the definition plus `/events`. Confirm lifecycle state and monotonically increasing event sequence persist.
8. Repeat once with `PACKETAGENT_STORE=sqlite`; run the managed-Postgres parity test before release when that mode is supported by the deployment.

## W3 Worker Activation Smoke

W3 ends at durable admission. A successful delivery creates a queued
`WorkerRun` and `worker.run` execution job; W4's scheduler handler now claims
and executes that job through the bounded supervisor.

1. Activate a deployment whose validated version contains enabled manual, cron, webhook, alert, and queue triggers with an input schema compatible with each test payload.
2. Manual: `POST /api/app/workers/deployments/:deploymentId/runs` with an `Idempotency-Key`, `triggerId`, and `input`. Confirm `202`, one activation inbox record, one queued run, and one execution job.
3. Replay that request byte-for-byte with the same key. Confirm the original run/job IDs return and `duplicateCount` increments. Change the input under the same key and confirm `idempotency_mismatch`; use a new key and confirm a distinct run.
4. Webhook: `POST /api/public/webhooks/workers/:webhookRef` with JSON plus `X-PacketAgent-Delivery-Id`. Replay the same delivery ID, then change the body under that ID. Confirm the same duplicate/conflict behavior while the legacy `/agents/:token` webhook still works.
5. Cron: run the Worker cron projector or wait for its minute job. Confirm one future `worker.activate.cron` job per active trigger, including its IANA timezone. Pause the deployment and confirm the projector cancels its queued occurrence.
6. Alert: emit a matching operations alert. Confirm the `alertEvents` record exists before the Worker activation and the alert event ID becomes the activation delivery ID.
7. Queue: call the queue adapter with the deployment, trigger, configured `queueRef`, and upstream message ID. Confirm that message ID is preserved as the delivery identity.
8. Send a valid `traceparent`/`tracestate` on manual or webhook intake and confirm its trace/span values are retained. Omit the headers and confirm a new valid trace is generated.
9. Include a sensitive field such as `api_key` or a payload larger than 32 KiB. Confirm the inbox and run hold an encrypted, expiring payload reference, workspace export omits ciphertext, and no raw value appears in events or jobs.
10. Restart PacketAgent and confirm inbox, duplicate count, queued run, execution job, and payload-reference metadata reload. Repeat the automated parity scenario for JSON, SQLite, and managed Postgres before release.

## W4 Bounded Worker Supervisor Smoke

1. Activate a Worker with one declared objective-satisfied exit predicate, a read-only test tool, and small positive time, iteration, provider-cost, failure, retry, and tool-call limits.
2. Confirm the `worker.run` job moves the version-pinned run from `queued` to `running`, acquires an owner/expiry/fencing lease, and emits supervisor events without exposing prompt, tool output, or exit evidence.
3. Return one planned tool call, a successful tool result, and a valid evaluation JSON object. Confirm the run advances plan -> act -> evaluate -> checkpoint -> decide, appends a cursor checkpoint, increments its optimistic revision, and completes with an explicit predicate terminal reason.
4. Script endless tool requests, a provider that never settles, repeated provider errors, invalid evaluation JSON, exact provider-cost exhaustion, and an iteration with no matched predicate. Confirm every case reaches a finite terminal or release outcome and provider/tool call counts stay within the pinned limits.
5. Request cancellation during each phase and while a provider ignores its abort signal. Confirm no later tool starts and the owned run terminates as `operator_cancelled`.
6. Revoke the deployment during execution. Confirm the supervisor observes the durable deployment state before another action and terminates the owned run as `deployment_revoked`.
7. Let a lease expire and acquire it from a second owner. Confirm the fencing token increases monotonically, stale event/checkpoint/terminal writes conflict, and the stale supervisor performs no later tool or terminal write.
8. Stop the scheduler while a Worker job is claimed. Confirm the signal reason releases both the runtime lease and job claim, returns the job to `queued`, and does not consume an attempt or report success.
9. Repeat acquire, checkpoint, and terminal persistence across JSON, SQLite, and managed Postgres. Confirm identical terminal status, checkpoint count, run revisions, and no active lease on the terminal run.

## W5 Checkpoint, Recovery, and Effect Safety Smoke

1. Run a Worker through plan and into a multi-action act phase. Confirm every appended checkpoint has a contiguous sequence, the previous checkpoint ID, a valid state digest, the pinned version, full redacted working memory, completed actions, pending approvals, artifacts, effect receipt IDs, remaining budgets, trace context, and creation time.
2. Stop the process with a nonterminal run holding an expired lease. Restart the scheduler and confirm recovery runs before claimed work, clears the expired lease, queues exactly one `worker.run` job without consuming an attempt, and resumes at the saved phase/action cursor.
3. Restart the same scheduler instance inside one recovery interval. Confirm startup reconciliation runs immediately again rather than waiting for the old interval.
4. Execute a mutating tool. Confirm a deterministic effect key and `prepared` receipt persist before the external call, then the same receipt becomes `completed` with only a redacted result reference after the call.
5. Replay an action with a completed receipt. Confirm the prior result returns and the external mutation counter remains one.
6. Crash after a non-replayable external effect but before receipt completion. On recovery, confirm the run and job are quarantined/failed as `unsafe_replay`; do not repeat the external call.
7. Repeat the prepared-receipt case with an idempotent mutator and a reconcilable mutator. Confirm the idempotent retry reuses one effect key, while reconciliation records proven completion without a second external call.
8. Corrupt a checkpoint digest, chain link, version reference, remaining budget, or action cursor. Confirm recovery quarantines the run with a redacted reason and never advances it.
9. Repeat the checkpoint/effect/recovery scenario against JSON, SQLite, and managed Postgres. Confirm equivalent receipt status, checkpoint count, run revisions, reacquisition, and terminal result.

## W6.1 Compiled Capability Policy Smoke

1. Validate a version containing `http_fetch`/`GET` and an uppercase-host HTTPS path scope ending in `/*`. Confirm the compiled tuple normalizes the verb, host, default port, and resource while retaining the version content digest.
2. Submit an unknown tool or verb, `*`, a host wildcard, FTP URL, URL with credentials/query/fragment, relative filesystem path, traversal segment, or non-`vault:` credential value. Confirm version validation fails with a path-addressable capability error.
3. Create a deployment without explicit grants. Confirm PacketAgent materializes the version policy's allowed capabilities as normalized grants and stores a deterministic compiled-policy digest.
4. Create another deployment with a subset of verbs/resources and change `approval` from `never` to `always`. Confirm the narrowed policy compiles. Attempt a new verb/resource or change required approval from `always` to `never`; confirm `invalid_input` and no deployment write.
5. Define overlapping grants for the same tool/verb/resource prefix with different approval requirements. Confirm compilation rejects the contradictory overlap.
6. Modify the stored policy digest, capability tuple, version digest, or deployment grant after creation. Confirm repository integrity rejects the record. Transition a valid deployment and confirm its grant and compiled policy remain immutable.
7. Repeat deployment creation, reload, export, and rollback through JSON, SQLite, and managed Postgres. Confirm the same normalized grants and compiled policy persist in every backend.
8. Treat this section as compilation evidence. Continue with the W6.2 smoke to verify runtime enforcement.

## W6.2 Immediate Tool Policy Enforcement Smoke

1. Activate a Worker deployment whose compiled policy permits one `http_fetch` `GET` path and requires no approval. Confirm the provider sees only tools backed by compiled `approval=never` tuples.
2. Request the allowed URL with query parameters. Confirm the operation normalizes to method plus scheme/host/path, the query value does not enter the policy event, and `worker.policy.allowed` is durably appended before the handler runs.
3. Request another host or path, a verb outside the grant, an `approval=always` tuple, a stale version digest, a modified policy digest, or a registered tool missing operation metadata. Confirm `worker.policy.denied`, no handler invocation, and no prepared effect receipt.
4. Exercise HTTP, GitHub, SQL, workspace, browser, Slack, email, and command adapters. Confirm they expose the expected verb/effect plus normalized URL, repository target, database, destination/recipient, command, and working-directory resources before authorization.
5. Inspect the allowed handler context. Confirm it contains the run, deployment revision and policy, version/content digest, matched capability, current budget usage, effect classification/operation, and system actor.
6. Inspect allow/deny event data. Confirm it contains only decision code, tool, verb, effect, policy/capability identifiers, resource schemes/count, and an operation digest; raw URLs, query values, selectors, commands, recipients, message bodies, SQL, and secrets must be absent.
7. Attempt execution through the production Worker adapter and the default
   registry catalog. Confirm both reach `executeTool`; direct Worker handler
   calls through registered definitions fail closed.
8. Continue through the W6.5 smoke before claiming the W6 permission gate.

## W6.3 Credential, Network, and Process Boundary Smoke

1. Store API-key, bearer-token, webhook-URL, SMTP-config, and opaque Worker
   credentials under `vault:` references in two workspaces. Confirm list and
   workspace export responses contain metadata only, with no ciphertext, IV,
   authentication tag, preview, or plaintext.
2. Run an allowed `http_fetch` with a declared credential reference. Confirm
   `worker.policy.allowed` is appended before the resolver runs and the secret
   resolves only immediately before the hardened request. Deny the operation,
   use an undeclared reference, or request the wrong credential kind and
   confirm neither credential resolution nor network I/O occurs.
3. Attempt loopback, link-local, private, carrier-grade NAT, documentation,
   multicast, IPv4-mapped IPv6, decimal IPv4, `.local`, and metadata targets.
   Confirm all are denied. Return mixed public/private A or AAAA results,
   change the connected address after resolution, or return a redirect and
   confirm the call fails closed.
4. Run Worker `run_command` and `shell_for_agent` with Docker available.
   Confirm the invocation has no network, no host environment, a read-only
   root, non-root user, PID/CPU/memory limits, dropped capabilities, and
   no-new-privileges. Select or fall back to the native driver and confirm the
   Worker command is refused even if interactive native sandbox opt-in is set.
5. Attempt Worker browser or SQL execution. Confirm those adapters fail closed
   until hardened Worker-specific drivers are configured. Exercise Worker SMTP
   through the R6.1 smoke below.

## R6.1 Vault-Backed SMTP Smoke

1. Store a strict JSON credential as kind `smtp_config` under
   `vault:smtp-primary`. Confirm the durable store and workspace export contain
   neither password nor username and expose only metadata.
2. Declare that reference in an immutable Worker version and grant
   `email_send` `SEND` only to `mailto:ada@example.com`. Send to another
   recipient and confirm the denial is recorded before credential resolution;
   no SMTP transport may be created.
3. Send to the allowed recipient. Confirm the order is policy approval,
   credential resolution, then SMTP. Supplying `from` in Worker input must
   fail; the sender comes from the encrypted credential.
4. Use a hostname with a mixed public/private A or AAAA answer, a private or
   local literal, plaintext mode, invalid certificate, failed STARTTLS, header
   newline, oversized body, or malformed credential field. Confirm each fails
   closed without persisting raw credentials or message content.
5. Abort an in-flight send and confirm the transport closes exactly once.
   Confirm successful tool output contains only the bounded message ID plus
   accepted/rejected counts.
6. Run `npm run verify:smtp`. All seven assertions must be true. The verifier
   uses deterministic fake DNS/SMTP and sends no live email.

## R6.2 LLM-Authored AgentTemplate Smoke

1. Configure a supported provider, open `/builder`, select **Build an agent**,
   and request a bounded manual or scheduled job. Confirm the draft identifies
   itself as `LLM-authored` and names the provider/model without exposing any
   key or credential value.
2. Review the draft before saving. Confirm the model-authored name, summary,
   description, instructions, typed inputs, playbook, acceptance checks, and
   open questions are visible, while the trigger and cron expression match the
   deterministic interpretation of the operator prompt.
3. Ask for an unregistered tool, a different trigger in the requested
   template, a secret-valued input, or secret-like assignment text. Confirm
   unregistered tools are removed, trigger substitution invalidates the model
   output, sensitive input keys are rejected, and assignment values are
   redacted.
4. Stop or misconfigure the provider, or return malformed/truncated output.
   Confirm the route still returns the deterministic draft with a visible
   fallback reason and does not fabricate provider authoring provenance.
5. Approve a valid draft. Confirm the existing Agent API persists and runs it
   without regression. Its compatibility projection must be a valid
   `legacy_agent` Worker version in `draft` status with the explicit
   `projection.requires_validation` warning; do not describe it as deployed
   through the canonical lifecycle.
6. Run `npm run verify:agent-template`. All assertions must be true. The
   verifier uses a deterministic fake provider, performs no live external
   calls, and certifies structured schema use, tool/trigger constraints,
   redaction, invalid-output fallback, and canonical Worker draft projection.

## R6.3 Agent Provider Readiness Smoke

1. Configure one hosted provider through an environment key or workspace-vault
   key, choose a Builder preset, and generate an Agent draft. Confirm authoring
   provenance, readiness, the saved model, and the saved provider route all
   identify the same resolved provider/model.
2. Confirm the readiness cards show provider registration, exact model,
   secret-free key source, `configured_unverified` model availability, and
   streaming/tool-use/structured-output support. No key value or vault
   credential reference may appear in the response or UI.
3. Remove every usable provider for the preset. Confirm readiness blocks the
   first run and a required tool-use capability is `missing`, not
   `conditional`.
4. Configure the local preset. Confirm it is labeled keyless but the selected
   model remains `configured_unverified`; configuration is not proof that the
   model exists at the endpoint.
5. Use a provider with model-dependent tool use or structured output. Confirm
   the conditional state and first-run verification warning remain visible.
6. Save the Agent, reconstruct the services/router, and confirm its stable
   provider route resolves to the original provider and the saved exact model
   overrides any route default.
7. Run `npm run verify:agent-readiness`. All seven assertions must be true.
   The verifier uses deterministic fake providers and performs no live
   provider or external tool calls.

## R6.4 Agent First-Run Evaluation Smoke

1. Generate an Agent in the Builder. Edit both bounded memory entries, the
   sample inputs, and the expected-output description. Save without running
   and confirm the memory, `inputSchema[].exampleValue`, and evaluation
   specification remain after reload.
2. For an Agent with a registered enabled tool, request the first run. Confirm
   no run is created before the explicit launch approval and that the approval
   lists only the enabled registered tools.
3. Approve and run with a configured provider. Confirm the model executes once
   through the bounded Agent loop and the saved memory is labeled as
   operator-authored non-secret context.
4. Expand the resulting run in Agent detail. Confirm the first-run evaluation
   shows expected and actual input, expected and actual output, tool-call
   evidence, four pass/fail checks, and review notes.
5. Open the run trace. Confirm a separate `evaluation` span carries the bounded
   redacted evidence and model identity.
6. Repeat with input drift, a failed provider setup, empty output, or a missing
   required tool. Confirm the evaluation fails closed and never fabricates a
   semantic score.
7. Enter a secret-like memory value, secret-key example, or secret-like
   expected output. Confirm save fails and no raw value reaches the Agent, run,
   evaluation, log, or UI response.
8. Run `npm run verify:agent-first-run`. All seven assertions must be true. The
   verifier is deterministic and performs no provider, tool, or network call.

## W6.4 Rolling Budget Smoke

1. Configure positive per-run limits plus explicit workspace and deployment
   rolling windows for provider cost and externally billable actions. Confirm
   legacy versions without the rolling object resolve to a finite bounded
   compatibility policy.
2. Start concurrent runs in one deployment with less rolling capacity than
   their combined maximum remaining provider cost. Confirm exactly one atomic
   reservation succeeds and no denied provider call starts.
3. Settle the successful provider hold below its reserved maximum. Confirm the
   unused capacity becomes immediately available while checkpointed per-run
   usage records the actual cost.
4. Repeat across two deployments. Confirm deployment limits isolate one
   deployment and the workspace limit aggregates both deployments.
5. Run allowed external HTTP, Slack, and GitHub operations. Confirm policy
   approval is recorded before one billable-action reservation, and that the
   reservation precedes effect preparation and network I/O. Denied policy
   operations must create no budget reservation.
6. Retry reserve, settle, and release with the same reservation key and amount.
   Confirm reserve reuses the active hold, repeated settlement is stable, and
   release never credits capacity twice.
7. Stop a process after reserve but before settlement, expire or replace its
   fenced lease, and run recovery twice. Confirm the first pass releases the
   abandoned hold with a reason and the second pass makes no change.
8. Repeat reserve/settle/release/export/reload against JSON, SQLite, and managed
   Postgres. Confirm equivalent reservation status and no lost concurrent
   update.

## W6.5 Permission Bypass Gate Smoke

1. Iterate the complete production tool catalog through `executeTool` with no
   compiled policy. Confirm each call records one denial and no handler runs.
2. Invoke every registered handler directly with a Worker context. Confirm
   each refuses execution without recording policy, resolving credentials, or
   performing I/O.
3. Execute an allowed registered tool, then attempt a nested direct call with
   its handler context. Confirm the one-shot permit is bound to the tool and
   has already been consumed.
4. Deny a credential-bearing HTTP call through the Worker adapter. Confirm the
   order contains only the policy denial: no rolling reservation, effect
   preparation, credential resolution, or network request occurs.
5. Repeat the W6.3 alternate-IP, mixed A/AAAA, DNS-rebinding, redirect,
   undeclared/wrong-kind credential, and native-sandbox cases.
6. Pass real linked and case-aliased host `cwd` values to both Worker command
   tools. Confirm both reject the host path before the sandbox port runs.
7. Pass shell substitutions, separators, quotes, and newlines as command
   arguments. Confirm each is encoded as quoted data in the no-network Docker
   request.
8. Repeat stale/tampered policy and concurrent rolling-reservation races.
   Confirm no registered path performs an undeclared action or exceeds a
   committed budget.

## W7.1 Durable Control Record Smoke

1. Create an attention request bound to one workspace, definition, deployment,
   run, immutable version digest, capability, and normalized operation digest.
   Confirm its escalation and expiry timestamps are bounded and its request
   key is unique.
2. Resolve it with an applied approve-once or approve-for-run command and an
   active approval grant. Confirm all three records agree on run, capability,
   operation, actor, scope, and version digest.
3. Confirm only the nonce digest is stored. Reuse that digest or a control
   idempotency key and verify repository integrity rejects the duplicate.
4. Exercise pending/applied/rejected commands and
   active/consumed/revoked/expired grants. Confirm terminal fields are required
   only for the matching status and one-time consumption requires an action ID.
5. Persist a notification delivery reference against a route declared by the
   immutable Worker version. Change its route kind/reference/event and confirm
   graph validation rejects it.
6. Reload and export the four collections in JSON, SQLite, and managed
   Postgres. Confirm backend results match and another workspace's records are
   excluded.
7. Confirm W7.2's service, rather than direct record mutation, is the only path
   used to execute these operator controls.

## W7.2 Atomic Control Service Smoke

1. Pause queued, running, and approval-waiting runs with the current run
   revision. Confirm the command applies atomically, the run becomes paused,
   its lease is fenced, queued execution work is canceled, and its checkpoint
   pointer and budget usage do not change.
2. Resume the paused run with its new revision. Confirm the same run becomes
   queued, exactly one command-bound execution job is added, and exact
   idempotent replay adds neither another transition nor another job.
3. Race two stop commands at the same expected revision. Confirm one
   terminalizes only that run and the stale command persists as rejected.
4. Revoke a deployed or active deployment. Confirm its revision advances to
   revoked, future activation fails, and all nonterminal runs become canceled
   with `deployment_revoked` while already terminal runs remain unchanged.
5. Approve once and approve for run against an open request and exact run
   revision. Confirm the capability and operation bindings match, the raw
   nonce appears only in the first service response, and only its digest
   persists. Reject a separate request and confirm no grant is created.
6. Attempt approval after expiry, beyond the request expiry, while the run is
   not waiting, and after another resolution won. Confirm every case fails
   closed with a durable rejection code.
7. Inject a failure after the target update. Confirm the command, target, job,
   and event all roll back. Repeat pause/approval/resume in JSON, SQLite, and
   managed Postgres and compare the resulting records.
8. Pause during a live provider phase and force the subsequent checkpoint
   write to encounter the control revision. Confirm the supervisor releases
   without another tool call or terminal write and a paused job is consumed
   without restarting execution.

## W7.3 Supervisor Approval Attention Smoke

1. Validate immutable attention policy with positive approval and escalation
   timeouts, escalation strictly before expiration, and an explicit `pause` or
   `reject` expiration disposition. Confirm invalid bounds fail version
   validation.
2. Request an `approval=always` tool operation. Confirm authorization denies it
   before budget, effect, credential, handler, or I/O work and atomically
   creates the exact pending-action checkpoint, open attention request, initial
   notification-delivery references, escalation/expiration jobs, audit event,
   and `waiting_for_approval` run state.
3. Restart and resume the run. Confirm resume is rejected until the latest
   checkpoint's exact attention is approved and its version, deployment,
   compiled policy, capability, operation, and expiration still match.
4. Approve once and replay the original action. Confirm the grant is consumed
   by that action and remains replayable only for that action. Approve for run
   and confirm reuse is limited to the same normalized operation. Confirm no
   raw nonce is persisted.
5. At the tool executor boundary, alter the action, capability, operation,
   policy digest, or expiration. Confirm the final recheck denies execution and
   the handler is never invoked.
6. Process the escalation deadline twice. Confirm at most one delivery
   reference exists per route and escalation stage and no duplicate escalation
   event is emitted.
7. Expire attention under both dispositions. Confirm `pause` preserves the
   checkpoint and budgets, while `reject` terminalizes with
   `approval_expired`; neither implicitly approves. Reject manually and confirm
   `approval_rejected` plus queued execution cancellation.
8. Repeat persistence and graph validation across JSON, SQLite, and managed
   Postgres. Send malformed or cross-workspace deadline work and confirm it
   fails closed without changing another workspace.

## W7.4 Independent Worker Operator API Smoke

Use authenticated requests under `/api/app/workers`. Every mutation requires
`Content-Type: application/json`, an `Idempotency-Key` header, and a positive
`expectedRevision`.

1. As a viewer, read `GET /runs/:workerRunId`, `GET /attention`, and
   `GET /attention/:attentionRequestId`. Confirm the response contains concise
   status, revision, budget, checkpoint, deadline, and safe tool/verb/effect
   context but no input, output, error, trace, runtime lease, raw event,
   compiled policy, request digest, nonce digest, or attention request key.
2. As a viewer, attempt every mutation and confirm denial before body parsing
   or target lookup. As a member, confirm pause/resume/stop are allowed but
   deployment revoke and approval remain denied. As an admin, confirm all four
   inspect/run-control/deployment-control/approval permission classes work.
3. Pause, resume, and stop one run through `/runs/:workerRunId/{action}`.
   Confirm the response revision advances once, replay returns the original
   command state without another job or transition, and a reused key with
   changed input returns `idempotency_mismatch`.
4. Revoke through `/deployments/:workerDeploymentId/revoke`. Confirm the
   concise deployment response is revoked, future activation fails, and all
   nonterminal run IDs are returned after terminalization.
5. Approve once, approve for run, and reject through the three attention
   action routes. Confirm a raw approval nonce appears only on the first
   applied approve response with `Cache-Control: no-store` and never appears
   in replay, storage, events, errors, or the projected grant.
6. Send an unknown JSON field, invalid revision/timestamp, missing idempotency
   key, unsupported content type, or malformed body. Confirm `invalid_input`
   and no command record. Replay a durable rejected command and confirm a
   stable HTTP 409 response with its concise rejection code.
7. Repeat every read and mutation with another workspace selected. Confirm
   reads return not found or an empty collection and controls cannot discover
   or change the other workspace's run, deployment, attention, grants, jobs,
   or commands.

## W7.5 Restart and Kill Gate Smoke

1. Create an approval wait, persist it, reconstruct the services from the
   durable store, approve it, replay the callback, and resume. Confirm only the
   exact pending action runs and replay returns no raw nonce or additional
   grant.
2. Race approve and reject at the same revision in both orderings. Confirm one
   command applies, one is rejected, and the attention, grant, run, event, and
   job graph remains consistent.
3. Stop through the real control service while the supervisor is in plan, act,
   evaluate, checkpoint, and decide. Confirm no event or tool action is written
   after the stop boundary.
4. Race activation and revoke in both orderings. Confirm the deployment ends
   revoked, any admitted run is canceled, queued work is canceled, and future
   activation is denied.
5. Reconstruct only the operator routes and their control dependencies from the
   durable store. Without Builder or PacketADE services, stop a run and revoke
   its deployment successfully.
6. Repeat the relevant restart and control persistence paths against JSON,
   SQLite, and managed Postgres and confirm equivalent terminal records.

## W8.1 Event and Evidence Model Smoke

1. Append a v2 journal occurrence and confirm the event plus its evidence entry
   commit atomically or neither record is visible.
2. Append interleaved occurrences for two deployments and runs. Confirm
   workspace, deployment, and run sequences remain strictly monotonic and
   ordered repository reads resume from the supplied cursor.
3. Drive activation through a terminal state. Confirm lifecycle, provider,
   tool, effect, checkpoint, approval, and control evidence carries the safe
   trace and durable record correlations without storing raw secret or input
   content.
4. Change a persisted event or evidence field and confirm digest validation
   rejects the graph before it can be used as trusted evidence.
5. Expire or remove the source behind an optional opaque raw-payload reference.
   Confirm the evidence summary, classifications, hashes, and source reference
   remain readable without copying the payload into evidence.
6. Persist an artifact manifest with a real content digest, media type, byte
   size, source evidence, materials, and generator provenance. Confirm
   provenance tampering fails validation, and do not create manifests for
   reference-only artifacts whose content was never observed.
7. Load a legacy v1 event and confirm it remains readable without fabricated
   evidence, trace, correlations, or digests.
8. Repeat the journal, artifact, workspace isolation, export, cursor, and
   migration paths against JSON, SQLite, and managed Postgres. Confirm
   dedicated event indexes and evidence/artifact tables preserve parity.

## W8.2 Deterministic Rollup Smoke

1. Run a Worker through provider, tool, checkpoint, approval, and terminal
   occurrences. Rebuild rollups and confirm one immutable version, deployment,
   and run identity receives the same scoped records.
2. Confirm correlated provider call status, tokens, cost, and duration plus
   successful and failed tool calls and mutation effects are counted once even
   when their correlation appears in more than one journal event.
3. Execute a retrying job and a supervisor phase failure. Confirm execution
   attempts, job retries, recovery requeues, provider failures, phase failures,
   and scheduled backoff remain separate counters.
4. Confirm queue duration uses persisted job scheduling and start timestamps,
   approval status uses durable attention/grant records, and the latest
   checkpoint is selected deterministically.
5. Compare reported per-run usage with reserved, settled, and released rolling
   provider/action capacity. Confirm additive values sum while the
   consecutive-failure gauge uses a maximum.
6. Add content-bound artifact manifests and matched/unmatched exit evaluations.
   Confirm byte totals, classifications, terminal status/reasons, and outcome
   quality counts roll up by run, deployment, and version.
7. Remove a correlated provider source record while retaining its
   event/evidence. Confirm rebuild succeeds, safe journal usage remains, and
   one deduplicated `provider_call` gap is reported instead of a zero or
   integrity failure.
8. Reverse every contributing source collection and reconstruct the repository
   through a fresh process-shaped loader. Confirm the complete projection is
   unchanged and another workspace receives no records.
9. Repeat the stable projection fields against JSON, SQLite, and managed
   Postgres and confirm equivalent results.

## W8.3 Retention and Redaction Smoke

1. Append an event containing sensitive keys, a structured bearer credential,
   and a known secret under a safe-looking key. Confirm neither the event nor
   its evidence contains the raw values.
2. Read legacy and current observability records through the repository with a
   known-secret resolver. Confirm the boundary pass removes values even when
   older persisted content was not sanitized.
3. Configure distinct metadata, summary, prompt, tool-payload, and artifact
   windows. Run a dry cleanup with small item/time bounds and confirm category
   metrics report eligible records without invoking a mutation or artifact
   deletion.
4. Run live cleanup for one workspace. Confirm expired activation payloads and
   terminal-run input/output disappear, checkpoint chains are removed with the
   latest pointer, and effect receipts retain status/timing/digest metadata but
   not result bodies.
5. Include an old queued or otherwise resumable run. Confirm its input,
   checkpoint, and effect state are untouched regardless of age.
6. Provide an artifact deletion adapter that accepts only a manifest reference
   plus expected content digest. Confirm successful or already-absent deletion
   records one tombstone; adapter failure records no false success. Never
   interpret arbitrary manifest references as filesystem paths.
7. Confirm every successful category deletion emits a public-metadata
   retention event containing only hashed resource IDs and content digests.
   Re-run cleanup and confirm no duplicate artifact deletion or tombstone.
8. Rebuild rollups after checkpoint retention. Confirm the missing source is
   counted as retention-deleted rather than unexplained.
9. Attempt a job whose payload workspace differs from the scheduler tenant, or
   whose bounds exceed their ceilings. Confirm it fails closed before cleanup.
10. Repeat persisted compaction against JSON, SQLite, and managed Postgres and
    confirm equivalent result kinds, event counts, exports, and rollups.

## W8.4 Worker Operations API and UI Smoke

1. Sign in as a workspace operator with `inspectWorkers`, open `/runs`, and
   confirm the page reads `/api/app/workers/health` plus the paginated
   `/api/app/workers/runs` projection. It must not fetch raw definitions,
   deployments, checkpoints, or journals and join them in the browser.
2. In an empty workspace, confirm the health cards report zero canonical runs
   and the table exposes one polite status message: `No canonical Worker runs
match this view.` Capture `w8-worker-list-empty.png`.
3. Activate a bounded Worker and confirm its row shows definition name, pinned
   version and deployment, live state, maximum budget utilization, latest
   checkpoint cursor, open-attention count, and last update. Capture
   `w8-worker-list-active.png`.
4. Exercise every state filter and load-more cursor. Confirm ordering remains
   stable when a newer run arrives, changing a filter invalidates the prior
   cursor, and a cursor copied to another workspace is rejected.
5. Open `/runs/worker/:runId`. Confirm one detail response answers the
   objective/trigger (why), version/deployment, state, hard budget and usage,
   provider cost, effect/tool totals, latest checkpoint, attention, evidence
   timeline, artifacts, and source gaps. Capture
   `w8-worker-detail-running.png`.
6. Put the run into approval attention. Confirm the detail exposes the bounded
   operation summary and exactly the approve-once, approve-for-run, and reject
   actions. Apply one action and confirm revision/idempotency races refresh
   from the authoritative detail instead of applying optimistic client state.
   Capture `w8-worker-detail-attention.png`.
7. Observe `/api/app/workers/events/stream`, terminate the connection after a
   known event ID, and reconnect with `Last-Event-ID`. Confirm no earlier event
   repeats, the stream closes at its duration/event ceiling with a resume
   sequence, and the normal paginated event endpoint refreshes the UI when SSE
   is unavailable.
8. Open `/activity` and return through **Canonical Workers**. Confirm inherited
   Agent runs remain intact and route-specific detail navigation does not
   collide with `/runs/worker/:runId`.

## W8.5 Answerability and Accessibility Gate

1. For one running, one waiting-for-approval, and one terminal Worker, answer
   from only the health/list/detail DTOs: what is running, why it is running,
   which immutable version/deployment is executing, current use versus every
   hard budget, last durable checkpoint, provider cost, required attention,
   evidence/artifacts, and terminal outcome. Any raw-table request or
   browser-side identity join fails the gate.
2. Rebuild the same DTOs after process replacement and after reversing source
   collection order. Confirm all cumulative fields and cursor ordering are
   identical.
3. Remove a correlated source record and repeat after retention tombstoning.
   Confirm unexplained and retention-deleted gaps remain distinct and neither
   case exposes retained secret content.
4. Exercise list and detail loading, error, empty, and ready states with a
   keyboard and accessibility tree. Loading/empty messages use polite
   `role=status`, failures use assertive `role=alert`, filter buttons expose
   `aria-pressed`, the search box has a label, tables retain headers, and every
   control has a unique accessible name.
5. At narrow and desktop widths, capture the four W8.4 screenshots above and
   confirm cards wrap, tables scroll without clipping controls, long opaque IDs
   and digests wrap, focus remains visible, and color is not the only state
   signal.
6. Repeat health, detail, evidence, artifact, cursor, and tenant-isolation
   reads through JSON, SQLite, and managed Postgres loaders. A storage-specific
   answer or ordering fails the gate.

## W9.1 WorkerPackage v1 Contract

1. Validate
   `src/workers/package/fixtures/worker-package-v1.valid.json`. Confirm every
   field maps to W1 provenance or `WorkerVersionContent`, artifact descriptors
   contain only references and digests, and no secret value appears.
2. Reorder object properties without changing array order. Confirm the
   canonical UTF-8 bytes and SHA-256 digest remain identical.
3. Change the objective, a capability resource, an artifact digest, or a
   policy bound without resealing. Confirm mandatory digest verification fails.
4. Remove every required Worker budget in turn, remove all exit predicates, or
   add an undeclared `apiKey`/token field. Confirm validation returns
   field-addressed failures before any deployment call exists.
5. Validate the unsupported-v2 fixture and confirm the unknown major fails
   closed at `$.schemaVersion`.
6. Attach a DSSE envelope whose payload is the exact canonical subject. Under
   optional trust policy, confirm the package remains digest-valid; under
   required trust policy, confirm at least one signature must pass the injected
   verifier.
7. Substitute different DSSE payload bytes, payload type, or an untrusted
   signature. Confirm validation or verification fails without treating
   `keyid` as authority.

## W9.2-W9.4 PacketADE Trust, Deployment, and Event Smoke

Use a PacketADE service credential scoped to the local workspace and only the
operations exercised below. Send it through `Authorization: Bearer`; never put
it in a URL, package, log, event, or evidence payload.

1. Validate the checked v1 fixture with its exact package idempotency key,
   explicit local capability IDs, and narrowed grants. Confirm a durable
   integrity/provenance receipt is returned without a Worker lifecycle write.
2. Deploy the same accepted package, activate its manual trigger, inspect the
   deployment, and list its runs. Replay each write with the same key and
   confirm the original IDs return without duplicate lifecycle effects.
3. Read the deployment and run event pages with `from=beginning`. Confirm every
   event uses `packetagent.packet-product-worker-event/v1`, has a stable opaque
   ID, immutable version identity, monotonic sequences, a trace ID or explicit
   trace gap, and a resolvable evidence link.
4. Open the SSE route, disconnect after an event, and reconnect with that
   event's `Last-Event-ID`. Confirm earlier events are not resent, later events
   retain their IDs, heartbeat and bounded-close frames arrive, and no durable
   acknowledgement was created.
5. Advance the cursor with `PUT .../events/cursor`, a fresh
   `Idempotency-Key`, and the page's strong `ETag` in `If-Match`. Confirm an
   exact retry returns the same acknowledgement, a concurrent stale ETag gets
   `412`, and acknowledging an older event never moves the effective cursor
   backward.
6. Construct a new service instance over the same durable store and read
   without an explicit cursor. Confirm delivery resumes after the
   acknowledgement. Remove the acknowledged source through the configured
   retention path and confirm `410` returns the minimum retained cursor.
7. Update to package v2, pause/resume it, roll back to the accepted v1 package,
   and revoke the resulting deployment. Confirm locally narrowed grants never
   broaden and deployment events project each transition.
8. Repeat receipt, binding, event acknowledgement, reload, and export checks
   through JSON, SQLite, and managed Postgres. Confirm the bearer secret and
   stored token digest are absent from every export and response.
9. Run
   `node --import tsx --test src/worker-package-handoff-gate.test.ts` and
   confirm the serialized disconnect/restart scenario passes. To opt into the
   real-network validation case, set
   `PACKETAGENT_PACKETADE_INTEROP_BASE_URL`,
   `PACKETAGENT_PACKETADE_INTEROP_TOKEN`, and
   `PACKETAGENT_PACKETADE_INTEROP_WORKSPACE_ID`; use HTTPS except for loopback.

## W10.1-W10.2 PacketChat Delivery Smoke

1. As a workspace admin, `PUT /api/app/workers/credentials` to create an
   opaque Worker credential at the route's declared `vault:*` reference.
   Confirm `GET` returns metadata only and `DELETE` removes it, while a
   non-admin receives `403`. Its plaintext JSON must use
   `packetagent.packetchat-route/v1` with `endpoint`, `callbackBaseUrl`,
   a 32-byte-or-longer `callbackSecret`, and optional `bearerToken`,
   `timeoutMs`, and `callbackTtlSeconds`.
2. Add a `packetchat` notification route using that exact reference to an
   immutable Worker version. Confirm a non-vault reference or a reference
   omitted from `credentialRefs` fails validation.
3. Produce attention, progress, and terminal Worker events. Confirm each source
   event/evidence/outbox/job commits atomically, the scheduler sends through
   the pinned-network port, and every retry uses the same W10.1 idempotency
   key.
4. Inspect the PacketChat request. Confirm it contains the exact immutable
   Worker identity/version digest, deployment/run state and reason, budget
   policy and usage, latest checkpoint, evidence link, required action, and
   bounded title/summary. The endpoint, bearer token, and callback secret must
   exist only during credential use.
5. Send multiple progress updates for one run. Confirm the thread and progress
   message keys remain stable with `replace` behavior. Confirm attention and
   terminal cards use `append`.
6. Follow open and inspect callbacks within their configured lifetime. Confirm
   open returns only the matching workbench URL and inspect returns W8's
   server-redacted run detail with `Cache-Control: no-store`.
7. Tamper with the signature or claims, expire the token, change workspace,
   deployment, run, version digest, audience, or route binding, and confirm
   authentication fails without returning Worker data.
8. Confirm JSON/SQLite/managed-Postgres records, exports, logs, events,
   evidence, outbox jobs, delivery metadata, and error messages contain no raw
   PacketChat endpoint credential, bearer token, callback secret, or signed
   callback token.
9. No live PacketChat endpoint is configured in this repository. Treat local
   fake-endpoint contracts as the W10.2 gate and leave real interoperability
   for W10.4.

## W10.3 PacketPhone Control Smoke

1. As a workspace admin, create an opaque Worker credential whose plaintext
   schema is `packetagent.packetphone-route/v1`. Use HTTPS endpoints, a
   32-byte-or-longer callback secret, one fixed PacketPhone actor ID and role,
   a role-valid allowed-action subset, and optional bearer, timeout, and
   callback-lifetime values. Confirm credential reads return metadata only.
2. Add a `packetphone` notification route using that exact declared `vault:*`
   reference. Confirm undeclared, non-vault, HTTP, weak-secret, weak-role, and
   role-invalid action configurations fail closed.
3. Produce an actionable Worker event. Confirm delivery contains the exact
   Worker, deployment, run, immutable version, source event/evidence, attention,
   and revision state, and only currently valid controls. Confirm callback
   tokens appear only in strict POST bodies and never in URLs.
4. Verify a member can pause or stop but cannot approve, reject, or revoke.
   Verify only admin/owner roles can receive and execute all five controls.
5. Execute approve, reject, pause, stop, and revoke through the PacketPhone
   callback. Confirm each delegates to W7 and creates the same durable control
   state and audit event as an independently authenticated local operator.
6. Serialize the durable store, construct fresh services, and replay a consumed
   callback. Confirm it is rejected without creating a second command, grant,
   nonce, transition, or external effect.
7. Exercise stale revisions, already-resolved attention, cross-workspace and
   cross-version substitution, token tampering, wrong audience/role/route, and
   expiry. Confirm every case fails without leaking Worker state.
8. Rotate the callback secret and confirm an old token stops authenticating.
   Deliver a new message and confirm its token succeeds under the new secret.
9. Repeat persistence and export checks through JSON, SQLite, and managed
   Postgres. Confirm endpoints, bearers, callback secrets, signed tokens, and
   approval nonces never persist; remote-control audit state contains only its
   source, role, audience, and token/nonce digests.
10. No live PacketPhone endpoint is configured in this repository. Treat the
    local fake-endpoint contract as the W10.3 gate and leave cross-product
    certification for W10.4.

## W10.4 Remote-Control Certification Smoke

1. Run both PacketChat and PacketPhone transports through fake hardened-network
   endpoints. Confirm each reloads the exact immutable Worker binding, keeps
   secrets ephemeral, and reuses W10.1's idempotency key.
2. Execute a local W7 action before a conflicting Phone callback, then reverse
   the order on fresh state. Confirm each ordering has one applied command, one
   revision-rejected command, and the correct local versus remote audit source.
3. Replay a Chat open/inspect callback and confirm the same read-only result
   returns with no mutation. Replay a consumed Phone callback before and after
   store serialization and confirm no second command, grant, nonce, or effect.
4. Rotate each callback secret. Confirm previously issued Chat and Phone tokens
   fail authentication while newly delivered tokens use the new credential.
5. Serialize a queued delivery, construct a fresh notification service, and
   deliver it. Confirm the provider sees the original external idempotency key.
6. Exhaust a delivery into dead-letter, redrive it with explicit attempt and
   expiry bounds, and confirm one fresh job plus one recovery event/evidence
   entry. Replay the same redrive request and confirm it creates no duplicates.
   After restart, deliver with the original external idempotency key.
7. Confirm a redrive fails closed if retention already compacted its source
   event/evidence.
8. The live Chat/Phone tests require the documented
   `PACKETAGENT_PACKETCHAT_INTEROP_*` and
   `PACKETAGENT_PACKETPHONE_INTEROP_*` settings. Without them, the two probes
   must report intentional skips rather than fabricated interoperability.

## First 10 Minutes: Self-Host Builder Smoke

Use this as the short confidence pass when time is tight.

1. Run `npm install && npm run dev`.
2. Sign in at `http://localhost:7341` with `alpha@packetagent.local` / `demo12345`.
3. Open `/builder`, choose **Build an app**, and submit `Build a lightweight CRM for renewal tracking`.
4. Confirm the draft shows generated source: page routes, API routes, data model, acceptance checks, and open questions.
5. Approve the draft. Confirm the **Generated source** tab lists source files and a workspace path under `data/generated-apps/<workspace>/<app>/workspace`.
6. Open the preview and confirm the iframe uses the isolated origin
   (`http://127.0.0.2:8484` by default), not the workbench origin. In browser
   storage, confirm the preview host has only an app-path-scoped
   `packetagent_preview_*` cookie and never `packetagent_session` or
   `packetagent_csrf`.
7. Open **Publish handoff**. Confirm it shows local package/runtime details, artifact paths, workspace manifest, health/smoke expectations, and next actions. It must not claim a cloud deployment unless a validated handoff URL and publish history entry exist.
8. Open **Source** for a saved generated app. Confirm package-plan status is
   visible, download the git-ready ZIP, and inspect the archive. It must contain
   source, `.gitignore`, `PACKETAGENT_EXPORT.md`, the package-install plan, and
   the checkpoint-bound export manifest. Confirm the plan says
   `executed: false`; an unapproved package or URL/git/local dependency must
   block installation without blocking source export.
9. Optional single-port serve: run `npm run build:web && npm start`, then open `http://localhost:8484`.

## Golden Path: Build An App

Sign in -> `/builder` -> describe an app -> saved local preview -> iterate -> publish handoff.

1. From the unauthenticated sign-in entry, submit `alpha@packetagent.local` / `demo12345`.
2. Confirm you land on `/builder`. The Build mode toggle should show **Build an app** selected.
3. Type a prompt such as `Build a lightweight CRM for renewal tracking`, then click the primary generate action.
4. Confirm a draft renders before any mutation. It should show app name, summary, plan steps, page map, data model, acceptance checks, and warnings/open questions when relevant.
5. Approve the draft. Confirm a new app and checkpoint are created and that a local preview path appears.
6. Open the preview. The workbench should mint an interactive capability,
   exchange it on the isolated preview origin, remove the URL fragment, and
   render the generated routes. Hold Cmd/Ctrl and click an element; selection
   should cross the validated message bridge without same-origin DOM access.
7. Submit a refinement prompt such as `Add an inline notes field to Account`. Confirm a dry-run change set is shown before mutation, including affected artifacts, route/privacy changes, acceptance checks, and rollback target.
8. Apply the change. Verify a new checkpoint is recorded and that the previous checkpoint is still listed in builder history.
9. Restore a previous non-current checkpoint from the history panel. Confirm the current pointer, preview state, and build/smoke metadata update.
10. Open the publish handoff area. Walk through readiness; confirm missing provider keys, webhook secrets, or base URLs are named by env key without exposing values, and that handoff remains private until required checks pass and the user explicitly approves public visibility.

Expected results:

- All builder calls hit `POST /api/app/builder/app-draft`, `POST /api/app/builder/app-draft/apply`, and the iteration / rollback endpoints with no console errors.
- Build/smoke status is visible at every stage, even when status is `not_run`, `blocked`, or `failed`.
- UI copy distinguishes generated source files, saved local preview, and publish handoff. It must not say the app is fully deployed unless a real URL/runtime artifact is present in publish state.
- No webhook tokens, API keys, or provider secrets are rendered in full.

## Agent Path: Build An Agent

Same golden flow, but for an agent with a schedule trigger, a webhook trigger, and a manual run.

1. From `/builder`, switch the build mode to **Build an agent**.
2. Type `Create a support triage agent that summarizes new tickets and drafts a reply`. Generate the draft.
3. Verify the draft preview includes name, description, instructions, input schema, recommended trigger, schedule or webhook recommendation, tools, provider/model, starter playbook, sample input, acceptance checks, and readiness warnings.
4. Approve the agent. The save call hits `POST /api/app/builder/agent-draft/approve`.
5. Edit the saved agent: add a webhook trigger via the agent editor (`/agents/:id`). Confirm the webhook URL and secret are shown but the secret is masked or revealable behind an explicit reveal.
6. Add or confirm a schedule trigger (cron expression). Confirm the schedule is shown in the agent overview.
7. Trigger a manual run from the builder run panel or `/runs`. Verify the run appears with transcript, tool calls, output, logs, model/cost, and a status pill.
8. From `/runs/<id>`, retry the run. Confirm a new run is created and that retry events flow through to activation (an `agent.run.retry` activity is recorded).
9. Trigger the webhook with `curl` against the webhook URL using the configured secret. Confirm a new run is created with `trigger=webhook` metadata.

Expected results:

- Manual, schedule, and webhook triggers each produce a run record visible at `/runs`.
- The retry path is idempotent for the same source run (no duplicate activation signal counts).
- Webhook tokens and API keys are never rendered in full.

## Workspace Setup

Onboarding stages live in `onboardingStates` and progress through:

| Step                       | Effect on activation facts                                |
| -------------------------- | --------------------------------------------------------- |
| `create_workspace_profile` | sets `briefCapturedAt`                                    |
| `define_requirements`      | sets `requirementsDefinedAt`                              |
| `define_plan`              | sets `planDefinedAt`                                      |
| `start_implementation`     | sets `implementationStartedAt`, `startedAt`               |
| `validate`                 | sets `testsPassedAt`, `validationPassedAt`, `completedAt` |
| `confirm_release`          | sets `releaseConfirmedAt`, `releasedAt`                   |

In a private window, sign up a fresh account at `/sign-up`. Walk through each onboarding step from the dashboard or activation view and confirm:

1. The dashboard "activation steps complete" counter increments.
2. The `/activation` view stage label moves through Discovery -> Definition -> Implementation -> Validation -> Complete as expected.
3. `GET /api/app/activation` and `GET /api/activation/:workspaceId` reflect the same status.
4. Sign-out returns to the unauthenticated sign-in entry.

Reset between passes by deleting `data/packetagent.json` or running `npm run store:reset` for the JSON store. For SQLite, run `PACKETAGENT_STORE=sqlite npm run db:reset`.

## Provider Configuration

1. Sign in as `alpha@packetagent.local` and visit `/integrations`. The breadcrumb reads "Providers".
2. Confirm the page lists configured model providers with one of: `connected`, `missing_key`, or another status pill.
3. Click **Add provider**. Add an Anthropic, OpenAI, or Ollama key.
4. Save and refresh. The new provider should now show `connected`. The status counter at the top of the page should update.
5. Verify the key is stored in the workspace vault, never echoed back. Re-opening the row should show only a redacted preview.
6. Switch to the **Tools** section and confirm the tool registry renders. Switch to **Environment** and confirm env vars render with secret values masked.

Optional: open `/builder` and re-run an app draft. The provider readiness section should now report the configured provider.

## Sandbox

1. Visit `/sandbox`.
2. Confirm the status panel shows the active driver. With Docker running it
   reports `docker`; without Docker it reports the sandbox unavailable unless
   the operator explicitly enabled the insecure native trusted-host driver.
   Native status must say `trusted-host-only` and untrusted code unsupported.
3. List sandbox runtimes. Pick a ready runtime in the composer.
4. With Docker, run `echo hello sandbox` with working directory `/workspace`.
   Confirm the run appears with status `success`, exit code `0`, and expected
   stdout. With native selected, confirm a member is refused and only an
   owner/admin can run the explicitly trusted diagnostic.
5. Run a long sleep (`sleep 30`) and click cancel. Confirm the run transitions to `canceled`.
6. Filter the executions table by `failed` and `success` to confirm filters work.

Required generated-code validation:

1. Ensure Docker is running and `docker ps` succeeds for the current user.
2. Run `npm run verify:codegen-sandbox`. The first run builds the
   Dockerfile/lockfile-addressed local validator image; later runs reuse it.
3. Confirm the JSON result has `ok: true`, `source: "real"`, and both
   `typecheck` and `build` set to `passed`.
4. Sign in and apply an app draft from `/builder` with smoke checks enabled.
   Verify the smoke section includes the real TypeScript and Vite phases.

Required sandbox boundary verification:

1. Run `npm run verify:sandbox-policy` with Docker available.
2. Confirm the result reports `ok: true`, `networkPolicy: "none"`,
   `filesystemPolicy: "read-only-root+bounded-tmpfs"`, and
   `environmentPolicy: "validated-explicit"`.
3. Confirm the boundary job could write under `/tmp` but not the container
   root, could not connect directly to `1.1.1.1`, and persisted its explicit
   environment value only as `[redacted]`.
4. Confirm the deadline job finishes with `status: "timeout"` and records the
   requested one-second wall-clock limit.
5. Through `POST /api/app/sandbox/exec`, try a secret-like environment name, a
   Docker working directory outside `/workspace` and `/tmp`, and a timeout over
   `PACKETAGENT_SANDBOX_MAX_TIMEOUT_MS`. Each must return a policy error before
   the driver starts.

Required brokered-egress verification:

1. Leave `PACKETAGENT_SANDBOX_EGRESS_ALLOWLIST` unset and submit an execution
   with `egress: [{ "id": "docs", "url": "https://example.com/data" }]`.
   Confirm it fails before Docker starts.
2. Set the allowlist to an exact test origin. Confirm sibling subdomains,
   credentials, fragments, alternate loopback forms, any mixed public/private
   A/AAAA result, a changed connected address, and redirects all fail closed.
3. Run `npm run verify:sandbox-egress`. Confirm it reports `ok: true`, one
   broker call, `networkPolicy: "brokered-prefetch"`, a materialized SHA-256
   receipt, direct container network denial, and
   `transientQueryPersisted: false`.
4. In `/sandbox`, enter one `id=https://allowed-origin/path` brokered input.
   Confirm the completed record shows only the redacted target, mount path,
   status, and size. The command may read `/input/egress/<id>` and
   `_manifest.json` but cannot mutate either.
5. Stop Docker and repeat. Confirm Builder reports blocked failure; it must not
   return pass or use the insecure native driver.

Required generated-preview isolation verification:

1. Run `npm run verify:preview-isolation`. It uses temporary SQLite/runtime
   state and must report `ok: true`, the distinct app/preview origins,
   `fragment-to-http-only-cookie`, and read-scope write status `403`.
2. Confirm a workbench-origin request to
   `/api/app/generated-apps/:appId/preview` returns `404`, even with a valid
   `packetagent_session`, and a preview-origin request to `/api/health` also
   returns `404`.
3. Confirm a minted preview URL has no query string and carries `#token=pt1…`.
   The bootstrap exchange must set a Secure, HttpOnly, `SameSite=None`,
   `Partitioned` cookie scoped to the one app path, then remove the fragment.
4. Confirm shared/read HTML uses `frame-ancestors 'none'`, an interactive
   document names only the exact workbench origin, inline scripts carry a
   fresh nonce, and generated connect/form/script sources are bounded.
5. Confirm a shared/read cookie can load preview assets and read runtime data
   but receives `403` for `POST`, `PUT`, `PATCH`, and `DELETE`.
6. In production, configure the dual-host Caddy or nginx example under
   `dev/deployment/examples/preview-origin/`. Use different HTTPS hostnames,
   preserve the reviewed Host/forwarded-host values, and confirm each virtual
   host rejects the other surface.

Required container-hardening verification:

1. Run `npm run verify:container-hardening` with Docker available.
2. Confirm the validator image reports numeric user `65534:65534`.
3. Confirm the resolved `controlPlaneCompose` and `generatedAppCompose`
   matrices each report non-root, read-only root, all capabilities dropped,
   no-new-privileges, init enabled, and their exact process limits (`256` and
   `128`).
4. Confirm the live sandbox reports UID/GID `65534`, all-zero `CapEff`,
   `NoNewPrivs: "1"`, `pidsMax: "64"`, and `rootWriteDenied: true`.
5. Certify a generated publish directory with
   `npm run verify:generated-app-publish -- <directory>`. Confirm the
   `container-hardening` step passes from a real `docker inspect`; changing
   only the source YAML must not satisfy this check.
6. Run the five R5 verifiers together after any sandbox, image, Compose,
   preview, or egress change: `verify:codegen-sandbox`,
   `verify:sandbox-policy`, `verify:sandbox-egress`,
   `verify:preview-isolation`, and `verify:container-hardening`.

Required Agent–Worker portability verification:

1. Run `npm run verify:agent-portability`. Confirm all eight assertions and
   the top-level `ok` field are `true`. This gate makes no network call.
2. As an admin, open an existing Agent and choose **Export**. Confirm the
   downloaded name ends in `.packetagent-agent.json`, the schema is
   `packetagent.agent-worker-bundle/v1`, and it contains SHA-256 Agent-bundle
   and Worker-content digests plus one Ed25519 DSSE signature.
3. Search the JSON for the source workspace ID, user ID, Agent ID, provider ID,
   webhook token, provider base URL, run output, and any known credential
   value. None may be present.
4. In **Projects**, choose **Import agent** and select the file. Confirm
   preflight shows signature verification, the publisher fingerprint,
   provider/tool readiness, `paused` Agent state, and `draft` Worker state
   before enabling the mutation.
5. Import the file. Confirm the Agent receives fresh local IDs, retains memory,
   input examples, evaluation expectations, playbook, trigger, and schedule,
   but is paused and has no webhook token, credentials, runs, or scheduled
   execution.
6. Move a file from another installation. Confirm an unconfigured publisher
   keeps the import button disabled until the displayed fingerprint is
   explicitly acknowledged. To pre-trust a verified publisher, add the exact
   fingerprint to `PACKETAGENT_AGENT_BUNDLE_TRUSTED_KEY_IDS` and restart.
7. Change any signed Agent or Worker field without resealing. Confirm preflight
   rejects the file. Add an unknown field or change the major schema version
   and confirm it also fails before creating an Agent.
8. Repeat an import request with the same `Idempotency-Key` and exact bundle;
   it must return the first imported Agent. Reuse that key with another valid
   bundle and confirm it returns a conflict.

Required canonical Agent execution verification:

1. Run `npm run verify:agent-canonical-execution`. Confirm all eight assertions
   and the top-level `ok` field are `true`. This gate makes no provider, tool,
   or network call.
2. Launch a providerless/tool-less Agent twice with the same
   `Idempotency-Key`. Confirm the second response has the same Agent run and
   canonical Worker run IDs, and only one `worker.run` job exists.
3. Reuse that key with different inputs. Confirm the launch fails with an
   idempotency conflict before provider or tool work.
4. Inspect the Agent run detail. Confirm it includes canonical definition,
   version, deployment, and run IDs and derives output, terminal state, trace,
   model/cost, tool summaries, and evaluation from Worker records/events.
5. Cancel a queued or running Agent run. Confirm a W7 `stop_run` command is
   issued for the linked Worker run and the compatibility status refreshes to
   canceled.
6. Activate a scheduled Agent, restart the service, and reconcile. Confirm the
   deployment has one canonical cron trigger, no recurring `agent.run` job is
   recreated, and the next delivery enters through the Worker activation
   inbox.
7. Edit an active scheduled Agent to name an unsupported tool. Confirm
   reconciliation cancels its canonical cron job and pauses the last valid
   deployment rather than falling back to legacy execution.
8. Run the SQLite backfill/verify and managed-Postgres parity suites. Confirm
   the four canonical link columns survive reconstruction and one workspace
   cannot resolve another workspace's Worker run.

## Operations Sanity

1. Visit `/operations`.
2. Confirm subsystem health renders. Subsystems should be `ok`; degraded or `down` entries warrant investigation before release.
3. Confirm the alert list. Active alerts should be zero unless the release is deliberately introducing one.
4. Confirm job metrics render with last duration, average, p95, and 24h counts. Look for stuck queues (`count24h > 0` but `lastMs` older than expected).
5. Visit `/storage`, `/backups`, and `/releases`. Confirm each renders without errors.
6. Visit `/settings` -> **Audit** tab. Confirm recent activity entries are present.

Run from the command line:

```bash
npm run jobs:recompute-activation         # refreshes activation read models
npm run jobs:repair-activation            # refreshes stale read models
PACKETAGENT_STORE=sqlite npm run db:status   # inspects pending SQLite migrations
```

Each should exit `0` with no warnings.

## Self-Host Sanity

SQLite backup -> restart -> restore -> confirm data round-trips. Use this section when `PACKETAGENT_STORE=sqlite`.

1. With seed data loaded, run:

   ```bash
   PACKETAGENT_STORE=sqlite npm run db:backup -- --backup-path=data/packetagent.sqlite.bak
   ```

2. Confirm a backup file is written.
3. Stop the server. Modify the database (sign in, create an app draft, apply it).
4. Run the restore:

   ```bash
   PACKETAGENT_STORE=sqlite npm run db:restore -- --backup-path=data/packetagent.sqlite.bak
   ```

5. Restart the server and sign in. Confirm the app draft created in step 3 is gone and the seed data is restored exactly.
6. For the JSON store path, repeat with `npm run store:reset` to confirm `data/packetagent.json` resets to the built-in seed state on next start.

## Build And Tests

Run the layers relevant to the change being shipped:

```bash
npm run typecheck
npm run test:api
npm run test:web
npm run build
```

Acceptance:

- Each command exits `0`.
- No new TypeScript errors.
- A production bundle exists under `web/dist/` after `npm run build:web` or `npm run build`. Do not commit it.

## Public Share And 404

1. Generate a share token from `/settings` -> **Share tokens**.
2. Open `/share/<token>` in a private window. Confirm it renders without auth, hides the workbench sidebar, and exposes a sign-in link.
3. Visit an unknown route such as `/this-does-not-exist`. Confirm a styled 404 renders and the primary recovery action returns signed-in users to `/builder` and signed-out users to `/`.

## Command Palette

1. Press **Cmd+K** or **Ctrl+K** in any signed-in view.
2. Confirm the modal opens, typing filters entries, and arrow keys + enter + escape work.
3. Confirm builder and new-build entries are prominent and Advanced operations entries are present but grouped under Advanced.

## Bug Capture

If an acceptance line fails, capture the network request/response and browser console output. Reference the section name in the bug title, for example `Manual Test - Provider configuration: key save returns 500`.
