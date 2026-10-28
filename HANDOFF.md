# PacketAgent handoff

Updated 2026-10-28. This is the short resume document for a new working
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
- The PacketADE-to-PacketBench rename is supported additively at the W9 source
  boundary. Current `PacketBench`/`packetbench` packages and frozen
  `PacketADE`/`packetade` packages both validate, while legacy credentials and
  replay namespaces remain stable.
- `npm audit` is not clean. As of 2026-10-27 the full audit reports 9 findings
  (2 moderate, 5 high, 2 critical) and `npm audit --omit=dev` reports 3 (1
  moderate, 2 high), all in transitive or exactly pinned dependencies
  (`nodemailer`, `hono`, `vite`, `zod`, `brace-expansion`,
  `postcss-selector-parser`, `shell-quote`, `source-map-js`).
  [`dev/r1-dependency-advisory-audit.md`](dev/r1-dependency-advisory-audit.md)
  owns the disposition. Earlier revisions of this file wrongly claimed a
  zero-vulnerability audit; treat the command output as the source of truth.
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

- live PacketChat interoperability remains blocked because PacketChat has no
  W10 ingestion/card endpoint or durable service credential; PacketPhone live
  certification still needs a real external endpoint and credential;
- hardened Worker-specific browser and SQL drivers remain unshipped and fail
  closed; and
- hosted PacketAgent Cloud and the other items named in the decision-gated
  list are outside the completed self-host MVP loops.

## Last verified R7/R8 gates

- `npm run verify:docs` - all 50 tracked Markdown files, local links,
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
- `npm run lint` - passed with zero errors and zero warnings. `npm run lint`
  now runs `eslint . --max-warnings=0`, so any new warning fails it.
- `npm run format:check` - passed and is a hard CI gate (no longer
  `continue-on-error`).
- `npm run test:api` - 1,757 total: 1,754 passed, 3 intentionally skipped
  live-interoperability probes, 0 failed. An earlier baseline run hit one
  Windows file-handle race (`src/workflow-prompt-service.test.ts` renaming the
  shared `data/packetagent.json`); the atomic JSON write retry budget was
  widened to absorb it and the suite is now green.
- `npm run test:web` - 72 passed, 0 skipped, 0 failed.
- `npm run verify:workbench-browser` - the authenticated browser gate now also
  covers Builder agent mode, the command palette, all twelve `/admin/:tab`
  surfaces, legacy Admin redirects, and a zero-console-error assertion.

## Known issues (2026-10-28)

Real defects found while auditing the advertised surface. Fixed ones are noted
as such; the rest are documented rather than silently shipped.

- Fixed: a cron trigger never carries input values, so a scheduled Worker whose
  input schema has a required field without a `defaultValue` used to fail
  admission forever. Cron projection now leaves such a trigger unscheduled
  instead of enqueuing a recurring activation that can never succeed, the seed
  and templates were corrected, and a legacy Agent that cannot project a valid
  Worker is left inert with a warning (marking it inert can no longer crash
  startup).
- Fixed: terminal job history is now bounded by an hourly retention reconciler
  (`PACKETAGENT_JOB_RETENTION_DAYS`, default 7 days, capped per pass); queued
  and running jobs are never pruned.
- Fixed: `PACKETAGENT_STORE=sqlite` no longer rewrites whole tables on every
  mutation. A mutation now diffs the mutated dataset against a row-signature
  snapshot taken when it was loaded and writes only the rows that changed or
  disappeared (`src/store/dedicated-tables.ts`, `src/store/backends/sqlite.ts`).
  A mutation that touches nothing in `jobs` no longer touches that table at all,
  and appending one job writes one row instead of every row. The whole-store
  _load_ is still O(dataset), so a mutation still scales with dataset size, but
  with a much smaller constant and no SQLite page/WAL write amplification.
- Fixed: every runtime SQLite consumer now shares one cached migration runner
  (`src/db/sqlite-database.ts`). A warm open checks `schema_migrations` instead of
  re-reading the migrations directory and every `.sql` file, so a scheduler poll
  no longer re-applies migrations. The eight duplicated migration runners under
  `src/repositories/` and `src/sandbox/sandbox-store.ts` were removed.
- Open: the `/builder` full-bleed layout does not mount the command palette; it
  is available in the workbench shell only.
- Open: the Admin Roles, SSO, and Rate-limits tabs are read-only
  reference/status views, not editable controls.
- Production note: the PacketAgent container on `10.80.12.12` was found
  unresponsive (`/api/health` never returned, ~40% CPU sustained, ~190 TB read /
  ~124 TB written since boot, healthcheck failing) after ~7 weeks with 127,500
  unbounded terminal jobs. On 2026-10-27 it was redeployed to the fixed build
  and its terminal-job history was pruned and the SQLite file compacted
  (97 MB -> 14 MB); it now reports healthy with `/api/health` 200 in ~3 ms and
  ~0.6% CPU. The two SQLite issues above were the underlying causes and are now
  fixed; the deployment runs the fixed build.

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
