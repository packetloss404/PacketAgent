# W1 canonical Worker contract plan

Status: completed implementation record for W1.

## Outcome

W1 introduces one storage-neutral, versioned domain contract for a bounded
PacketAgent Worker. It does not add repositories, migrations, routes, UI, or a
supervisor. Those changes begin in W2 and W4 after the contract gate passes.

## Research findings

### Current PacketAgent boundaries

- `AgentRecord` is mutable and combines authoring, provider selection, tools,
  trigger configuration, and activation status.
- `AgentRunRecord` has useful transcript, log, tool-call, model, and cost data,
  but no immutable Worker-version reference or durable checkpoint cursor.
- `runAgentLoop` caps model turns at eight by default, but does not express the
  complete time, cost, tool-call, and failure policy required by PacketAgent.
- Existing triggers are `manual`, `schedule`, `webhook`, and `email`. The
  canonical contract uses `manual`, `cron`, `webhook`, `queue`, and `alert`;
  legacy email is projected as an email-adapted webhook trigger.
- The current workflow model is a workspace-scoped brief, requirements, plan,
  concerns, and validation evidence. It is authoring context, not an executable
  or deployed Worker.
- The repository has no runtime schema dependency. W1 therefore uses strict
  TypeScript types plus dependency-free runtime validators and Node test-runner
  tests.

### External design constraints

- Durable orchestration instances must remain associated with the version that
  created them; changing in-flight orchestration logic breaks deterministic
  replay. This supports immutable validated Worker versions and version-pinned
  Worker runs.
  [Azure Durable orchestration versioning](https://learn.microsoft.com/en-us/azure/azure-functions/durable/durable-orchestration-versioning)
- Durable execution needs persisted progress and deterministic replay
  boundaries. W1 records a phase cursor, completed actions, pending approvals,
  artifacts, and remaining budgets without implementing replay yet.
  [Durable orchestrations](https://learn.microsoft.com/en-us/azure/durable-task/common/durable-task-orchestrations)
- Event identity must distinguish an occurrence from a delivery attempt.
  CloudEvents defines uniqueness as `source` plus `id`; W1 keeps trigger
  definitions unambiguous and leaves the delivery envelope/deduplication record
  to W3.
  [CloudEvents specification](https://github.com/cloudevents/spec/blob/ce@stable/cloudevents/spec.md)
- Cross-process correlation needs stable trace context. W1 reserves trace and
  parent-span identifiers on runs and checkpoints; W3/W8 will propagate and
  surface them.
  [OpenTelemetry traces](https://opentelemetry.io/docs/concepts/signals/traces/)

## Contract decisions

1. Every top-level record carries `schemaVersion`.
2. `WorkerDefinition` is the stable identity and mutable display metadata.
3. `WorkerVersion` owns executable content. Draft content can change;
   validated content is immutable and a deployment can reference only a
   validated version.
4. `WorkerDeployment` owns activation lifecycle. Updating executable content
   creates a new Worker version rather than changing its version reference.
5. `WorkerRun` is pinned to both a deployment and Worker version.
6. `WorkerPolicy` requires positive limits for elapsed time, iterations,
   provider cost, consecutive failures, and tool calls. Permission defaults are
   deny and grants reference declared capabilities.
7. `WorkerTrigger` is a closed discriminated union. Kind-specific fields may
   not be mixed.
8. Terminal deployment and run states cannot transition.
9. PacketADE provenance is stored on the Worker version, including flight,
   project, conversation, repository, and revision when supplied.
10. Legacy projections are explicitly draft compatibility views. They do not
    claim that the unified Worker lifecycle is deployed or active.

## Implementation loops

### Loop 1 - Schema kernel

- Add `src/workers/types.ts`.
- Define JSON-safe primitives, actors, provenance, input schema, execution
  profile, capabilities, policy, triggers, exit predicates, and the seven W1
  records.
- Gate: TypeScript compiles and fixtures can represent manual, cron, webhook,
  queue, and alert Workers.

### Loop 2 - Runtime validation

- Add `src/workers/validation.ts`.
- Validate schema versions, identifiers, timestamps, policy bounds,
  capability references, trigger discriminators, record relationships, content
  digests, terminal reasons, and checkpoint budgets.
- Gate: invalid schemas return path-addressable issues and assertion helpers
  reject them.

### Loop 3 - Lifecycle and immutability

- Add `src/workers/transitions.ts`.
- Define version, deployment, and run transition maps.
- Reject transitions out of terminal states.
- Reject content mutation after validation and any version mutation while it is
  deployment-bound.
- Gate: table-driven tests cover every allowed edge and representative invalid
  edges.

### Loop 4 - Legacy projections

- Add `src/workers/projections.ts`.
- Project `AgentRecord` and workspace workflow records without mutating or
  changing existing APIs.
- Use deterministic compatibility identifiers and digests.
- Map schedule to cron, email to an email-adapted webhook, and current
  whole-tool grants to explicitly coarse capability requests.
- Gate: projections are deterministic, contain no webhook token or credential
  value, retain source IDs, and remain draft.

### Loop 5 - W1 gate

- Run focused Worker tests, typecheck, lint on authored files, API tests, web
  tests, and `git diff --check`.
- Check off W1 only when tests reject invalid transitions, mutable deployed
  versions, missing bounds, and ambiguous triggers.

## File boundary

```text
src/workers/
  index.ts
  types.ts
  validation.ts
  transitions.ts
  projections.ts
  __tests__/
    fixtures.ts
    validation.test.ts
    transitions.test.ts
    projections.test.ts
```

## Deferred deliberately

- JSON, SQLite, and Postgres persistence and migrations (W2)
- lifecycle commands, optimistic concurrency, and idempotent activation (W2)
- normalized activation/delivery envelopes and deduplication (W3)
- supervisor execution and policy enforcement (W4/W6)
- checkpoint persistence, replay, and effect receipts (W5)
- APIs, events, and PacketADE package ingestion (W9)

## Verification

- Focused Worker contract tests: 31 passed
- Full API suite: 1,270 passed, 1 skipped, 0 failed
- Web suite: 25 passed, 0 failed
- Typecheck: passed
- Production web build: passed
- Authored-file lint and formatting: passed
- Repository lint: 0 errors, 146 inherited warnings
- `git diff --check`: passed
