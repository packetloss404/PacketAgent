# PacketAgent roadmap

This is the short product direction. Detailed acceptance criteria and sequencing live in [`../BACKLOG.md`](../BACKLOG.md).

Current active loop: **W2 - Worker persistence, versioning, and activation**. Repository/session state
for a new Codex project lives in [`CODEX-HANDOFF.md`](CODEX-HANDOFF.md).

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

These pieces work, but they are not yet unified as one durable Worker lifecycle. The existing builder remains supported and becomes the worker creation studio. Prompt-to-app generation remains an inherited secondary capability.

## Now

### 1. Durable Worker contract - complete

The storage-neutral canonical Worker, WorkerVersion, WorkerDeployment, WorkerRun, WorkerCheckpoint, WorkerPolicy, and WorkerTrigger records, runtime validators, transition guards, immutable-version checks, and legacy agent/workflow projections are implemented under `src/workers/`.

### 2. Worker persistence and activation - active

Support draft, validated, deployed, active, paused, and retired deployments. Only validated immutable versions can activate. Persist version provenance and idempotency keys.

### 3. Trigger adapters

Normalize manual, cron, webhook, alert, and queue activations into a single activation envelope. Deduplicate repeated delivery and record the trigger source.

### 4. Bounded supervisor loop

Build the recoverable plan-act-evaluate loop around the existing agent runtime. Enforce maximum elapsed time, iterations, cost, tool permissions, and failure count. Require explicit success, pause, approval, budget-exhausted, cancelled, or failed terminal states.

### 5. Checkpoint and recovery

Persist run cursor, working memory, completed actions, pending approvals, artifacts, and external-effect idempotency keys. Resume interrupted runs without replaying completed side effects.

## Next

### 6. Permission and attention controls

Move from whole-tool approval to verb/resource-scoped capabilities. Add pause, resume, stop, revoke, approve-once, approve-for-run, and escalation routing.

### 7. Worker health, cost, and evidence

Roll provider calls, queue health, checkpoints, retries, approvals, and outcomes up by worker and deployment. Make "what is running, why, at what cost, and what needs me" answerable from one screen.

### 8. PacketADE handoff

Implement the versioned deployment contract in [`packetade-packetagent-handoff.md`](packetade-packetagent-handoff.md): **Deploy to PacketAgent**, **Keep running**, update, inspect, pause, and revoke. Return progress and approval events to PacketADE.

### 9. PacketChat and PacketPhone routes

Send worker summaries and approval requests to conversation and mobile surfaces after the core lifecycle and policy model are stable.

### 10. Integrations and worker templates

Expand connectors and ship useful worker starters only after the runtime can execute them safely and recoverably.

## Later

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
