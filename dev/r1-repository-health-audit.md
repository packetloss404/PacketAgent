# R1 repository health audit

Last updated: 2026-07-28.

This is supporting evidence for
[`R1`](../BACKLOG.md#r1---repository-health-and-historical-finding-re-audit).
`BACKLOG.md` remains the only implementation ledger. Historical review files
are inputs to this re-audit, not active task lists.

## Status vocabulary

- **Fixed**: current code and a current test or gate close the finding.
- **Stale**: current code proves the historical finding no longer applies.
- **Open**: current evidence still reproduces the finding or the audit is not
  complete.
- **Later loop**: intentionally assigned to a named backlog loop.

## Historical P0/P1 findings

| Historical finding | Current status | Current evidence |
| --- | --- | --- |
| JSON mutations can race and file replacement is not atomic | Fixed | `src/store/json-io.ts` serializes mutations per path and replaces a same-directory temporary file atomically with bounded Windows retry coverage. JSON and SQLite/managed parity suites remain in the API gate. |
| Managed Postgres creates and closes a pool for every operation | Fixed in current R1 slice; full R1 gate pending | `src/store/backends/managed-postgres.ts` now caches one production pool per connection-URL digest, returns dedicated transaction clients to that pool, and closes pools during server shutdown. `managed-postgres-pool.test.ts` proves reuse and explicit shutdown. Test-injected clients remain operation-scoped so isolation and concurrency fixtures retain their existing semantics. |
| Destructive migrations lack recovery and foreign-key validation | Fixed in current R1 slice; full R1 gate pending | Destructive SQL already creates a timestamped, WAL-checkpointed pre-migration backup. Migration and restore now run `integrity_check` and `foreign_key_check`; a corrupt restore candidate is rejected without replacing the current database. Migrations `0012`, `0013`, `0015`, and `0016` copy data forward before table swaps. |
| Managed backfill deletes target-only records | Fixed in current R1 slice; full R1 gate pending | Managed backfill now makes source records authoritative only for matching identities, preserves target-only records, and does not rewrite a target whose only difference is additional records. |
| Jobs have multiple writers and incomplete workspace scoping | Fixed in current R1 slice; full R1 gate pending | SQLite store mutations already load and persist the dedicated `jobs` table inside one `begin immediate` transaction. R1 removed the redundant post-commit repository upsert, so a claim cannot be reverted by a stale second writer. Repository and scheduler find/update/cancel APIs now require `(workspaceId, jobId)`; cross-workspace reads/updates return null, and an upsert cannot replace another workspace's identity. |
| Persistence has no documented end-state | Open | R1 must document which of JSON, SQLite, managed document Postgres, and entity repositories is authoritative for each deployment/migration stage. No compatibility facade may be removed first. |

## Other historical findings

| Area | Current status | Current evidence or next check |
| --- | --- | --- |
| Quoted Node test globs | Stale | `package.json` quotes the API and web test globs, and the current suites discover the expected files on Windows. |
| Sandbox fail-open and host-environment leakage | Fixed by W6/current runtime | `src/sandbox/sandbox-service.ts` requires an explicit insecure-native opt-in when Docker is unavailable; `src/sandbox/native-driver.ts` allowlists inherited environment entries. Worker command execution is Docker-only and no-network. |
| CI has no type/test/build/lint coverage | Stale with formatting debt open | `.github/workflows/ci.yml` runs install, typecheck, API/web tests, web build, lint, and Docker build. Formatting remains non-blocking until R1 completes the inherited baseline. |
| Dependency advisories | Open | R1 will record direct/transitive ownership and reachable production risk before any upgrade. Forced upgrades are not authorized. |
| Scheduler rejection can crash or fail silently | Fixed | `JobScheduler.tick` catches detached `runJob` failures with redacted logging, distinguishes coordinator authentication failure, guards terminal-write failures, and logs recurring enqueue failure. Current focused scheduler coverage includes all three historical failure paths. |
| Startup truth, rate-limit identity, artifact scope, response headers/CSP | Open audit | Inspect current server and route tests, reproduce only still-applicable findings, and close them in the next R1 backend/security slice. |
| Error boundary, iframe sandbox/title, corrupt-row handling, complete redaction, dead controls, button types, explicit bootstrap | Open audit | Inspect the current React workbench and route projections, then close verified findings in the R1 frontend slice. |
| Generated-app runtime/persistence convergence | Later loops R4/R5 | R1 may fix security/correctness defects, but file-tree generation and generated-app runtime convergence remain governed by R4/R5. |
| Oversized compatibility modules | Later loop R7 unless correctness requires a smaller extraction | R1 preserves public facades while documenting the persistence boundary. Repository modularization belongs to R7. |

## Current R1 persistence verification

- `npm run typecheck`: passed.
- Focused managed-pool reuse test: 1 passed.
- Focused migration corruption, restore preservation, and managed-backfill
  tests: 4 passed.
- Focused job repository/read/route/dual-write/scheduler/webhook tests: 91
  passed, 0 failed.
- `npm run test:api`: 1,513 passed, 4 intentionally skipped live probes, 0
  failed (1,517 total).
- Full web/build/lint/format gates and the remaining R1 slices remain required
  before R1 can close.
