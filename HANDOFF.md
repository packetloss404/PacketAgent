# PacketAgent handoff

Updated 2026-08-01. This is the short resume document for a new working
session. [`BACKLOG.md`](BACKLOG.md) is the sole implementation ledger;
[`dev/CODEX-HANDOFF.md`](dev/CODEX-HANDOFF.md) retains the detailed shipped
inventory and gate history.

## Product boundary

PacketAgent is the self-hosted, always-available control plane for durable
autonomous Workers in the Packet suite. Workers are event-driven and bounded,
not endless token loops.

Every Worker must remain:

- bounded by time, cost, iterations, failures, and permissions;
- permissioned at the runtime tool boundary;
- resumable from durable checkpoints;
- safe against duplicate external effects;
- auditable through events, evidence, and provenance; and
- independently stoppable and revocable.

Use `PacketAgent`, `packetagent`, and `PACKETAGENT_*` for new identifiers.
TaskLoom naming is compatibility-only.

## Current status

- R1-R6 are complete.
- R7, Builder and frontend maintainability, is active.
- R8, release reliability and production packaging, follows R7.
- The exact active slice is **R7.1c: split the oversized App Builder view along
  its existing controller, thread, preview, tab, and publish seams**.

R6.6 removed the legacy Agent execution choice. Accepted Agent launches and
active schedules now materialize and enter the canonical Worker lifecycle
before provider or tool work. `AgentRunRecord` is a compatibility read model
linked to canonical definition, version, deployment, and run IDs. Worker
checkpoints, approvals, effects, budgets, evidence, control, and terminal state
remain authoritative.

R7.1 is in progress:

- [`dev/r7-frontend-maintainability.md`](dev/r7-frontend-maintainability.md)
  records the measured five-module audit and bounded subloops.
- R7.1a is complete. Agent editor loading, mutations, coordinated state, and
  API actions live in `use-agent-editor-controller.ts`; controlled approval,
  playbook, tool, memory, input, launcher, run-history, transcript, evaluation,
  and tool-call UI live in feature-owned modules.
- `agent-editor.tsx` fell from 2,443 to 548 lines. Its controller is 537 lines;
  every extracted feature module is below 400 lines.
- Nine focused characterization tests cover typed payloads, playbook
  validation, approval risk, controlled empty/populated states, run history,
  evaluation evidence, tool calls, and bounded serialization.
- R7.1b is complete. The former 4,381-line Builder route module is now a
  12-line compatibility facade over eleven feature-owned modules covering
  contracts, draft/apply, generated-app lookup/export, iteration and its pure
  transforms, checkpoints, publish handlers, publish artifacts, Agent publish,
  smoke validation, and route registration.
- Every Builder route feature module is below 800 lines. A 35-route inventory
  characterization test and the existing 46-test focused route selection
  preserve the registration, authorization, iteration/checkpoint,
  source/export, preview/smoke, publish/integrity, rollback, and permission
  boundaries.

## Exact resume point

Continue R7.1c in `web/src/workbench/views/builder.tsx`:

1. Characterize the current draft/stream controller and the existing thread,
   preview, tab, and publish state contracts before moving behavior.
2. Retain one controller for the current draft and stream; extract focused
   hooks and controlled feature components with explicit props and callbacks.
3. Preserve routing, stream cancellation/retry, preview selection, iteration,
   and publish behavior while reducing the production view below 1,000 lines.
4. Add focused component/controller coverage and run the standard R7 subloop
   gate.
5. Continue the audited R7.1 order with `builder-agent.tsx`, then
   `settings.tsx`.

Do not mark R7.1 complete until every production view/route module named in the
audit is below 1,000 lines or has an explicit ownership justification, and the
repository gates pass.

## Last verified gates

- `npm run typecheck` — passed.
- `npm run lint` — passed with zero errors and zero warnings.
- `npm run format:check` — passed.
- `npm run build:web` — passed.
- `npm run test:web` — 48 passed, 0 failed.
- `npm run test:api` — 1,658 passed, 3 intentional live interoperability
  skips, 0 failed (1,661 total).
- `npm run verify:agent-canonical-execution` — all 8 assertions passed without
  live provider, tool, or network calls.

R7.1b additionally passed the 46-test focused Builder route selection and the
full 1,661-test API regression suite.

## Known conditional or unshipped work

- Live PacketChat and PacketPhone interoperability certification remains
  conditional on real endpoint credentials. Local adapter, replay, rotation,
  race, and dead-letter gates pass.
- Hardened Worker-specific browser and SQL drivers remain unshipped and fail
  closed for Worker runs.
- R8 still owns broader happy paths, release claims, backup/restore,
  production-image, and packaging reliability.

## Resume commands

```powershell
Set-Location D:\projects\PacketAgent
git branch --show-current
git status --short
git remote -v
npm run typecheck
npm run test:web
```

Expected branch after this handoff is merged: `main`.

Expected remotes:

- `origin` — `git@github.com:packetloss404/PacketAgent.git`, writable;
- `taskloom-source` — historical migration source, read-only by convention.

Stop if the worktree is unexpectedly dirty, the active directory is
`D:\projects\taskloom`, or `origin/main` does not contain this handoff.

## Canonical references

- Remaining work and gates: [`BACKLOG.md`](BACKLOG.md)
- Public product truth and setup: [`README.md`](README.md)
- Detailed implementation handoff:
  [`dev/CODEX-HANDOFF.md`](dev/CODEX-HANDOFF.md)
- Short direction: [`dev/roadmap.md`](dev/roadmap.md)
- Executable loop map:
  [`dev/worker-implementation-loops.md`](dev/worker-implementation-loops.md)
- R7 audit and subloops:
  [`dev/r7-frontend-maintainability.md`](dev/r7-frontend-maintainability.md)
- Verification: [`dev/TESTING.md`](dev/TESTING.md)
- Shipped history: [`CHANGELOG.md`](CHANGELOG.md)

Historical files under `docs/`, repo-review notes, and old phase documents are
records only. They do not override this handoff or add active work outside
`BACKLOG.md`.
