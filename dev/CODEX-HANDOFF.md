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
in foundation commit `d60cd47`. W1 and W2 are implemented as isolated changes
on this branch. Do not reset this branch to the historical source remote.

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

- one normalized trigger envelope;
- trigger-driven canonical Worker run creation;
- durable supervisor checkpoints and crash recovery;
- external-effect idempotency receipts;
- resource/verb-scoped capabilities;
- Worker-level attention, evidence, and cost rollups; and
- PacketADE-to-PacketAgent deployment endpoints.

Do not describe those missing Worker features as implemented.

## Exact resume point

Start with **W3 - Trigger and activation envelope** in
[`../BACKLOG.md`](../BACKLOG.md).

W1-W2 are complete under `src/workers/`, the store, migration, and private
route modules. W1's design record is
[`worker-contract-plan.md`](worker-contract-plan.md). W2 preserves the
storage-neutral domain model while adding the repository and control-plane
lifecycle. It does not yet execute a Worker.

The exact first slice is
[`W3.1 - Define the envelope and inbox records`](worker-implementation-loops.md#w31---define-the-envelope-and-inbox-records).
After each gate passes, continue through W4-W10 and then R1-R8 using that
document's autonomous execution protocol. Historical D/phase/track documents
have been reconciled there and must not be resumed independently.

## Canonical documents

- Product truth: [`../README.md`](../README.md)
- Short direction: [`roadmap.md`](roadmap.md)
- Work ledger and gates: [`../BACKLOG.md`](../BACKLOG.md)
- W3-W10 and inherited execution map: [`worker-implementation-loops.md`](worker-implementation-loops.md)
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
- `npm run test:api` - 1,288 passed, 1 skipped, 0 failed
- `npm run test:web` - 25 passed, 0 failed
- focused Worker lifecycle, route, and export checks - 54 passed
- `git diff --check` - passed
- compatibility-only old-name scan - passed

Known inherited quality debt:

- repo-wide `npm run format:check` flags 367 files;
- full dependency audit reports 11 advisories, including 2 critical
  development-tree advisories; and
- production-only audit reports 5 advisories: 1 low, 1 moderate, 3 high,
  0 critical.

Do not use `npm audit fix --force` or format the entire repository as an
incidental part of W3. Track those cleanups separately in the backlog.

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

Expected status after the W2 commit: clean. Stop if the active folder is
`D:\projects\taskloom`, the foundation commit is absent, or unrelated changes
appear unexpectedly.
