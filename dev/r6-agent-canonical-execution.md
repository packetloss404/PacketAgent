# R6.6 canonical-only legacy Agent execution

Status: complete on 2026-07-29. `BACKLOG.md` remains the sole implementation
ledger.

## Goal

Keep the existing Agent authoring, run, activity, and first-run evaluation APIs
compatible while deleting the legacy execution choice. Every accepted Agent
launch must resolve to these durable canonical records before provider or tool
work begins:

1. one `WorkerDefinition` linked by `WorkerVersion.source.kind =
"legacy_agent"` and `sourceId`;
2. one immutable, validated `WorkerVersion` for the current Agent content
   digest;
3. one compiled, revisioned `WorkerDeployment`;
4. one idempotently admitted `WorkerRun` and `worker.run` job;
5. canonical supervisor checkpoints, policy decisions, approvals, effects,
   evidence, budgets, control, and terminal state.

The legacy `AgentRunRecord` becomes a compatibility read model keyed to the
canonical run. It is not an execution authority.

## Research

- Microsoft's
  [anti-corruption layer pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer)
  recommends isolating translation between legacy and modern semantics so the
  modern domain is not weakened by the old API. It also calls out validation,
  consistency, correlation, and structured observability at that boundary.
- Microsoft's
  [strangler fig pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig)
  supports routing one capability at a time to a replacement while old callers
  continue using their stable surface.
- AWS's
  [Making retries safe with idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
  recommends caller-intent identifiers, atomic persistence with the mutation,
  semantically equivalent replay responses, and rejection when the same key is
  reused for different intent.

PacketAgent already has the required canonical lifecycle receipts, activation
inbox, immutable version binding, execution job, fenced supervisor, effect
receipts, and control records. R6.6 must reuse them rather than introduce a
parallel migration queue or runner.

## Characterized legacy contract

The compatibility boundary that must remain available is:

- Agent CRUD and provider-readiness fields;
- `POST /api/app/agents/:agentId/runs`, including the existing coarse
  tool-launch review before admission;
- Agent run list/detail, trace, cancel, retry, diagnose, and record-as-playbook;
- first-run evaluation attached to the Agent run response;
- scheduled, webhook, and email Agent entry points;
- workspace isolation, existing role checks, activation signals, and activity
  records.

Behavior that is explicitly replaced:

- `runAgentWithToolLoop` must no longer call `runAgentLoop`;
- tool-less Agents must no longer fabricate a successful local transcript;
- `agent.run` scheduler work must only adapt a legacy delivery into canonical
  activation and must not perform provider or tool work itself;
- cancel must target the canonical `WorkerRun`, then refresh the Agent read
  model;
- retries create a new canonical activation and never reuse a terminal run.

## Migration identity and versioning

- Definition ID: `compat:agent:<agent-id>:definition`.
- Version identity is content-derived and immutable. The lifecycle service still
  assigns the monotonically increasing version number inside its transaction.
- Deployment identity is version-derived. Rollout replaces the prior
  nonterminal deployment and preserves its active/paused posture.
- Lifecycle command idempotency keys include the Agent ID, operation, and
  canonical content digest.
- `WorkerVersion.source` remains the durable migration link. No local provider
  ID, credential, webhook token, or approval token is copied into Worker
  content.
- Re-running migration after a crash returns the same definition, version, and
  deployment or continues the first incomplete lifecycle transition.

Agent edits create a new Worker version only when the execution content digest
changes. Old runs remain pinned to their original version and deployment.

## Trigger compatibility

Executable legacy projections carry a manual trigger plus the authored
automatic trigger when applicable:

- manual Agent API launches use `manual`;
- schedule deliveries use `cron`;
- webhook and email deliveries use `webhook` with the existing adapter
  distinction.

Paused Agents retain a paused deployment. A permitted manual launch may resume
the deployment for the atomic activation admission and return it to paused
after the run is durably queued. A queued run remains version-pinned and may
execute while the deployment is paused; no new activation can enter.

Active scheduled Agents use only canonical cron projection. Migration cancels
queued legacy schedule jobs, and legacy recurring-job code cannot recreate
them.

## Dynamic tool resource compatibility

Legacy Agents name whole tools but do not persist canonical resource upper
bounds. Converting that to a wildcard grant would violate the Worker policy
model.

R6.6 therefore adds an approval-bound resource sentinel:

- it is accepted only on a capability whose approval mode is `always`;
- it never grants a tool operation by itself;
- it lets the model request the tool so canonical authorization can derive the
  concrete verb, effect, and resources;
- the runtime returns `approval_required`;
- only a durable Worker approval whose capability, policy digest, and exact
  operation digest match may authorize execution.

This is narrower than the old whole-run launch token. The launch review remains
for API compatibility, while the canonical action approval remains the runtime
authority. No hostname, recipient, repository, channel, database, browser
session, command, or filesystem resource becomes an implicit wildcard.

## Compatibility read model

`AgentRunRecord` stores canonical definition, version, deployment, and run IDs.
Refresh derives:

- Agent `success` from Worker `completed`;
- Agent `failed` from Worker `failed`, `budget_exhausted`, or `quarantined`;
- Agent `canceled` from Worker `cancelled`;
- queued/running compatibility states from nonterminal Worker states;
- output, redacted error, provider cost/model evidence, and tool summaries from
  the Worker run and journal.

The canonical IDs are returned as additive fields. Existing fields and routes
remain present.

## Failure and recovery rules

- No provider or tool call occurs before lifecycle materialization and
  activation admission commit.
- A crash after admission leaves the canonical `worker.run` job queued.
- Inline manual execution and scheduler execution acquire the same fenced
  Worker lease. A later duplicate handler observes busy or terminal state.
- Compatibility refresh is replayable and has no external effect.
- Migration conflicts fail closed and preserve the last validated deployment.
- Unsupported legacy tools block canonical materialization with a safe
  readiness error; they never fall back to the legacy runner.

## Executable gate

`npm run verify:agent-canonical-execution` must prove without network calls:

1. deterministic, restart-safe materialization;
2. immutable version rollover after an Agent edit;
3. canonical activation/run/job creation;
4. no call path to the legacy loop;
5. Agent API/read-model compatibility links;
6. canonical stop propagation;
7. schedule migration without duplicate legacy jobs;
8. JSON, SQLite, and managed-Postgres persistence parity.

R6 is complete only after the full repository gates and this verifier pass.

## Implementation result

R6.6 removes the legacy execution choice while preserving its public surface:

- `src/agents/canonical-materialization.ts` creates deterministic definitions,
  immutable content-derived versions, and compiled deployments through the
  lifecycle service;
- `src/agents/canonical-execution.ts` admits idempotent Worker activations and
  executes the same `worker.run` handler used by the scheduler;
- `src/agents/canonical-run-compatibility.ts` derives legacy run detail,
  trace, evaluation, output, error, model, cost, and tool-call fields from
  canonical run state and events;
- `src/agents/canonical-reconciliation.ts` migrates active schedules to cron
  activation, retires archived definitions, cancels obsolete `agent.run`
  schedule jobs, and makes a prior deployment inert if edited content cannot
  be projected safely;
- `src/workers/capabilities.ts` and policy enforcement implement the
  approval-bound resource sentinel without introducing a wildcard grant; and
- SQLite migration `0030_agent_run_worker_links.sql`, dedicated-table
  persistence, managed-Postgres projection, backfill, and verification carry
  the four canonical IDs.

The legacy direct provider/tool loop is absent from the Agent service. Manual,
schedule, webhook, and email entry points only adapt delivery intent into the
canonical lifecycle. Cancellation targets the linked Worker run.

## Gate evidence

- `npm run verify:agent-canonical-execution`: all eight assertions pass without
  provider, tool, or network calls.
- Focused canonical execution, restart/idempotency, immutable rollover,
  schedule migration, control, approval-bound policy, and three-backend
  persistence tests pass.
- Typecheck, zero-warning lint, formatting, production web build, and all 39
  web tests pass.
- The full API regression passes: 1,657 passed, three intentional live
  interoperability probes skipped, zero failed (1,660 total).

R7 and R8 subsequently closed. No automatic implementation slice follows R8;
new work requires an explicit decision from `BACKLOG.md`.
