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
in foundation commit `d60cd47`. W1 is implemented as the next isolated change.
Do not reset this branch to the historical source remote.

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

## Current implementation truth

Implemented substrate:

- storage-neutral canonical Worker domain records, validators, transition
  guards, content digests, version pinning, and draft legacy projections;
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

- Worker repositories and migrations in JSON, SQLite, and managed Postgres;
- immutable Worker deployment operations and activation lifecycle;
- one normalized trigger envelope;
- durable supervisor checkpoints and crash recovery;
- external-effect idempotency receipts;
- resource/verb-scoped capabilities;
- Worker-level attention, evidence, and cost rollups; and
- PacketADE-to-PacketAgent deployment endpoints.

Do not describe those missing Worker features as implemented.

## Exact resume point

Start with **W2 - Worker persistence, versioning, and activation** in
[`../BACKLOG.md`](../BACKLOG.md).

W1 is complete under `src/workers/`. Its design and implementation-loop record
is [`worker-contract-plan.md`](worker-contract-plan.md). W2 should keep those
domain files storage-neutral while adding JSON, SQLite, and managed Postgres
repositories, migrations, lifecycle operations, activation idempotency, and
optimistic concurrency with backend parity coverage.

## Canonical documents

- Product truth: [`../README.md`](../README.md)
- Short direction: [`roadmap.md`](roadmap.md)
- Work ledger and gates: [`../BACKLOG.md`](../BACKLOG.md)
- PacketADE contract: [`packetade-packetagent-handoff.md`](packetade-packetagent-handoff.md)
- W1 contract plan and decisions: [`worker-contract-plan.md`](worker-contract-plan.md)
- Rename compatibility: [`taskloom-to-packetagent.md`](taskloom-to-packetagent.md)
- Verification: [`TESTING.md`](TESTING.md)
- Shipped history: [`../CHANGELOG.md`](../CHANGELOG.md)

Historical documents are labeled at their top and must not override this
handoff, the roadmap, or the backlog.

## Last verified gates

- `npm run typecheck` - passed
- `npm run lint` - passed with 0 errors and 146 inherited warnings
- `npm run build:web` - passed
- `npm run test:api` - 1,270 passed, 1 skipped, 0 failed
- `npm run test:web` - 25 passed, 0 failed
- focused Worker contract tests - 31 passed
- `git diff --check` - passed
- compatibility-only old-name scan - passed

Known inherited quality debt:

- repo-wide `npm run format:check` flags 367 files;
- full dependency audit reports 11 advisories, including 2 critical
  development-tree advisories; and
- production-only audit reports 5 advisories: 1 low, 1 moderate, 3 high,
  0 critical.

Do not use `npm audit fix --force` or format the entire repository as an
incidental part of W2. Track those cleanups separately in the backlog.

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

Expected status after the W1 commit: clean. Stop if the active folder is
`D:\projects\taskloom`, the foundation commit is absent, or unrelated changes
appear unexpectedly.
