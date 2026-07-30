# PacketAgent handoff

Updated 2026-07-30. This is the short resume document for a new working
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
- The exact active slice is **R7.1a: finish decomposing the Agent editor along
  controlled feature seams**.

R6.6 removed the legacy Agent execution choice. Accepted Agent launches and
active schedules now materialize and enter the canonical Worker lifecycle
before provider or tool work. `AgentRunRecord` is a compatibility read model
linked to canonical definition, version, deployment, and run IDs. Worker
checkpoints, approvals, effects, budgets, evidence, control, and terminal state
remain authoritative.

R7.1 has started:

- [`dev/r7-frontend-maintainability.md`](dev/r7-frontend-maintainability.md)
  records the measured five-module audit and bounded subloops.
- Agent editor typed launch/playbook/approval helpers moved to
  `web/src/workbench/views/agent-editor/helpers.ts`.
- Transcript, first-run evaluation, and tool-call presentation moved to
  `web/src/workbench/views/agent-editor/run-presenters.tsx`.
- Six characterization tests cover those seams.
- `agent-editor.tsx` fell from 2,443 to 2,095 lines without moving its
  parent-owned state or changing API behavior.

## Exact resume point

Continue R7.1a in `web/src/workbench/views/agent-editor.tsx`:

1. Extract controlled approval, playbook, tool, memory, input, and run-history
   components into the existing `agent-editor/` feature directory.
2. Preserve `AgentEditorView` as the single owner of coordinated state while
   those components receive explicit values and event handlers.
3. Add characterization coverage before moving controller/network logic.
4. Then extract the controller hook and confirm the production view is below
   the R7.1 size threshold.
5. Continue the audited R7.1 order: `builder-core.ts`, `builder.tsx`,
   `builder-agent.tsx`, then `settings.tsx`.

Do not mark R7.1 complete until every production view/route module named in the
audit is below 1,000 lines or has an explicit ownership justification, and the
repository gates pass.

## Last verified gates

- `npm run typecheck` — passed.
- `npm run lint` — passed with zero errors and zero warnings.
- `npm run format:check` — passed.
- `npm run build:web` — passed.
- `npm run test:web` — 45 passed, 0 failed.
- `npm run test:api` — 1,657 passed, 3 intentional live interoperability
  skips, 0 failed (1,660 total).
- `npm run verify:agent-canonical-execution` — all 8 assertions passed without
  live provider, tool, or network calls.

The API total is the R6.6 full-regression checkpoint. R7.1 changes since then
are frontend-only and have passed typecheck, lint, formatting, production
build, and the expanded web suite.

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
