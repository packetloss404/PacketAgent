# PacketAgent handoff

Updated 2026-08-01. This is the short resume document for a new working
session. [`BACKLOG.md`](BACKLOG.md) is the sole implementation ledger;
[`dev/CODEX-HANDOFF.md`](dev/CODEX-HANDOFF.md) retains the detailed shipped
inventory and gate history.

## Product boundary

PacketAgent is the self-hosted, always-available control plane for durable
autonomous Workers in the Packet suite. Workers are event-driven and bounded,
not endless token loops.

Every Worker must remain bounded, permissioned at the runtime tool boundary,
resumable from a durable checkpoint, duplicate-effect safe, auditable, and
independently stoppable or revocable. Use `PacketAgent`, `packetagent`, and
`PACKETAGENT_*` for new identifiers. TaskLoom naming is compatibility-only.

## Current status

- PA0, W1-W10, and inherited R1-R8 are complete.
- R7 closed the five-module ownership audit; introduced shared accessible
  async-state and tab primitives; centralized client formatting; documented a
  token-driven, incrementally migrated styling direction; and added component
  plus real-browser coverage for Builder app and Worker operations modes.
- R8 persists bounded quality transcripts on every new generated-app
  checkpoint and on refresh, rollback, and branch operations. The release gate
  covers sign-in, app build/approval/iteration/preview/publish, Worker
  deploy/run/inspect/reconnect/revoke, path traversal, preview isolation,
  artifact integrity, rollback, backup/restore, and tenant isolation.
- Production now builds ESM JavaScript for Node 22 with source maps and a
  separately built generated-app runtime worker. `npm start` runs
  `dist/server.js`; `npm run start:dev-server` retains the source/tsx path.
- The production image was built and booted as a non-root, read-only container
  with the expected plain-Node command. Optional Playwright remains a dynamic
  runtime import.
- No autonomous implementation loop remains. Work under
  [`BACKLOG.md#decision-gated-work`](BACKLOG.md#decision-gated-work) requires an
  explicit owner decision and must not start automatically.

## Exact resume point

Start by checking the repository and the decision-gated section of
`BACKLOG.md`. Do not invent an R9 or resume an archived D/phase/track plan.
Choose a new product objective only after the owner explicitly selects it.

The highest-value known constraints, not automatic tasks, are:

- live PacketChat and PacketPhone interoperability certification still needs
  real external endpoints and credentials;
- hardened Worker-specific browser and SQL drivers remain unshipped and fail
  closed; and
- hosted PacketAgent Cloud and the other items named in the decision-gated
  list are outside the completed self-host MVP loops.

## Last verified R7/R8 gates

- `npm run verify:docs` - all 48 tracked Markdown files, local links,
  documented npm commands, authority boundaries, backlog state, and README
  screenshot assets passed.
- `npm run verify:release` - 13 deterministic gate groups passed. This includes
  the documentation gate,
  5 focused app happy-path tests, the serialized PacketADE Worker handoff gate
  with its intentional live-network skip, 39 path/preview/artifact/rollback
  regressions, 2 backup/restore cases, tenant isolation, claim audit, built
  server boot, and the authenticated browser pass.
- `npm run verify:production-image` - image built; command is
  `node --enable-source-maps dist/server.js`; non-root read-only runtime became
  ready.
- `npm run typecheck` - passed.
- `npm run lint` - passed with zero errors and zero warnings.
- `npm run format:check` - passed.
- `npm run test:api` - 1,662 total: 1,659 passed, 3 intentionally skipped
  live-interoperability probes, 0 failed.
- `npm run test:web` - 58 passed, 0 skipped, 0 failed.

See [`dev/r8-release-reliability.md`](dev/r8-release-reliability.md) for the
requirement-to-evidence matrix and reproducible commands.

## Resume commands

```powershell
Set-Location D:\projects\PacketAgent
git branch --show-current
git status --short
git remote -v
npm run typecheck
npm run verify:release
```

Expected local branch: `main`. It may be ahead of `origin/main` when a session
was asked to commit without pushing; inspect the divergence before publishing.

Expected remotes:

- `origin` - `git@github.com:packetloss404/PacketAgent.git`, writable;
- `taskloom-source` - historical migration source, read-only by convention.

Stop if the worktree is unexpectedly dirty, the active directory is
`D:\projects\taskloom`, or the remote topology differs from the two entries
above.

## Canonical references

- Product truth and setup: [`README.md`](README.md)
- Remaining decision-gated work and gate history: [`BACKLOG.md`](BACKLOG.md)
- Detailed implementation handoff:
  [`dev/CODEX-HANDOFF.md`](dev/CODEX-HANDOFF.md)
- Short direction: [`dev/roadmap.md`](dev/roadmap.md)
- Completed loop map:
  [`dev/worker-implementation-loops.md`](dev/worker-implementation-loops.md)
- R7 evidence:
  [`dev/r7-frontend-maintainability.md`](dev/r7-frontend-maintainability.md)
- R8 evidence: [`dev/r8-release-reliability.md`](dev/r8-release-reliability.md)
- Verification: [`dev/TESTING.md`](dev/TESTING.md)
- Shipped history: [`CHANGELOG.md`](CHANGELOG.md)

Historical files under `docs/`, repo-review notes, and old phase documents are
records only. They do not override this handoff or create active work outside
`BACKLOG.md`.
