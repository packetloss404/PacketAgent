# PacketAgent - Repository Engineering Review

> **Status: archived point-in-time review.** This 2026-06-17 report predates
> the PacketAgent foundation rename and several fixes it discusses. Its counts,
> branch state, and severity conclusions must not be treated as current. Use
> [`dev/CODEX-HANDOFF.md`](dev/CODEX-HANDOFF.md), [`dev/roadmap.md`](dev/roadmap.md),
> and [`BACKLOG.md`](BACKLOG.md) for current work.

_Senior-staff review | 2026-06-17 | read-only analysis (no application code changed)_

Branch reviewed: `main`. The working tree has **266 uncommitted modified files** - this review reflects the working-tree state, not the last commit.

---

## A. Executive Summary

PacketAgent is a self-hostable "build internal apps & agents from a prompt" workbench: a **Hono (Node 22, TypeScript-via-`tsx`, ESM)** REST+SSE API in `src/` plus a **React 19 + Vite 7 + React Router 7** SPA in `web/`. It brings-your-own LLM keys across several providers, generates app code via an LLM file-tree author, runs that code in a sandbox, previews it, and publishes it. Persistence is pluggable - `json` (single file), `sqlite` (generic `app_records` doc table + dedicated per-entity tables), and managed Postgres - and the codebase is visibly **mid-migration** from the monolithic document store to per-entity repositories, leaving a large amount of dual-write / read-parity scaffolding behind. It is a feature-rich, genuinely ambitious codebase (~314 `src` files, ~73 KLOC) with strong instincts in places (parameterized SQL, scrypt passwords, AES-256-GCM secret vault, an excellent first-run preflight, a clean API client).

However, it is **not production ready** in its current state. The headline problem is that **`npm test` silently runs only ~36% of the test suite** (a shell-glob bug skips ~91 files including store, RBAC, auth, route, and security tests), so the green build is an illusion. On top of that, the **untrusted-code sandbox fails _open_ to host execution with full secret inheritance** outside `NODE_ENV=production`, the **default JSON store has no write serialization** (lost updates / data loss under concurrency), several **migrations `DROP TABLE` populated tables** with no backup, there is **no CI and no linter**, and a handful of files are 3,000-5,000 lines of mixed responsibility. The architecture is sound at the seams but buried under an oversized deployment-governance subsystem (~one-third of `src`) that models human sign-off workflows for a capability the code itself classifies as not-yet-built.

**Overall rating: Risky -> Not production ready.** The data-layer engineering and security primitives are above-average for a pre-1.0 project, but the test suite doesn't actually run, the sandbox default is unsafe, and the default store loses data under load. These are fixable without a rewrite; most of the top issues are small, surgical changes.

---

## B. Top 10 Highest-Priority Issues

### 1. `npm test` silently skips ~64% of the test suite - CRITICAL | testing

- **Files:** `package.json:68-70` (`test:api`, `test:web`)
- **What's wrong:** `node --import tsx --test src/**/*.test.ts` lets the **shell** expand the glob. npm runs scripts via `/bin/sh`; `**` collapses to a single `*`, matching only one directory level. **Verified:** `find` sees 143 API test files; the glob passes only **52**. The 71 top-level `src/*.test.ts` (incl. `packetagent-store.test.ts`, every `*-routes.test.ts`, `rbac.test.ts`, `server-security.test.ts`) and all deep `src/**/__tests__/*.test.ts` (providers, jobs, security, tools, activation) are **never run**. `test:web` has the same bug - only `error-translator.test.ts` runs; `builder-copy.test.tsx` is skipped.
- **Why it matters:** `npm run build` calls `npm test`, so it reports green while store integrity, auth, RBAC, and sandbox-security tests never execute. Every other quality gate is undermined by this. Real failures may already be hiding.
- **Fix:** Quote the pattern so Node (not the shell) expands it: `node --import tsx --test "src/**/*.test.ts"` (Node's own runner supports `**`), or `node --import tsx --test $(find src -name '*.test.ts')`. Same for `test:web`. Then triage whatever turns red.

### 2. Untrusted code sandbox fails _open_ to host execution + leaks all secrets - CRITICAL | security/RCE

- **Files:** `src/sandbox/sandbox-service.ts:434,446-456,591`; `src/sandbox/native-driver.ts:87`
- **What's wrong:** Default driver is `auto` (verified line 434). If the Docker probe fails for any reason, `auto` falls back to the **native driver, which runs commands directly on the host** (lines 454-456). The only guard, `assertNativeAllowedInProduction`, is a no-op unless `NODE_ENV === "production"` (line 591) - so in dev/staging/unset-NODE_ENV, attacker-controlled generated code runs on the host the moment Docker is unavailable, with **no opt-in**. Worse, `native-driver.ts:87` spawns the child with `env: { ...process.env, ... }`, so the untrusted process inherits `MASTER_KEY`, all provider API keys, and `DATABASE_URL`, which can be exfiltrated over the SSE response. The fallback selection is also cached for the process lifetime (line 454), so one transient Docker hiccup pins the server to native until restart.
- **Why it matters:** Full remote code execution on the host plus total secret disclosure - the worst combination, reachable by default in any non-production deployment.
- **Fix:** Fail _closed_ - require `PACKETAGENT_ALLOW_INSECURE_NATIVE_SANDBOX=true` to use native in _all_ environments; default driver to `docker`; **throw** instead of falling back when Docker is unavailable; don't cache a native selection. Never spread `process.env` into the child - pass a minimal allowlist (`src/tools/sandbox.ts:98` already does this correctly; copy that pattern).

### 3. Default JSON store has no write serialization - lost updates / data loss - CRITICAL | bug

- **Files:** `src/packetagent-store.ts:838-854,1078-1081,1113-1126`
- **What's wrong:** `mutateStoreAsync` returns the **shared cached** store object, `await`s the mutator (an event-loop yield point), then `writeFileSync`s the whole file - with no mutex, queue, or atomic write. Two concurrent HTTP mutations operate on the same in-memory object and last-writer-wins overwrites the file. A reader doing `JSON.parse(readFileSync(...))` can also observe a partially written file. `json` is the documented default store; the Postgres path is correctly serialized (advisory lock + tx) and SQLite uses `begin immediate` - only the default is unprotected.
- **Why it matters:** Silent data corruption/loss under any concurrency, on the out-of-the-box backend.
- **Fix:** Serialize JSON mutations through an in-process promise chain/mutex; write atomically via temp-file + `rename`.

### 4. Migrations `DROP TABLE` populated tables with no backup - CRITICAL | data loss

- **Files:** `src/db/migrations/0012_agent_runs.sql:1`, `0013_jobs.sql:1`, `0015_activities.sql:1-2`, `0016_provider_calls.sql:1-2`
- **What's wrong:** Each unconditionally `drop table if exists <t>` then recreates it empty. These run via the runtime lazy migrator (`packetagent-store.ts:1480`) on first open. On any DB that already populated those tables under the `0003` schema, **first app start silently destroys** agent-run history, the job queue (incl. in-flight jobs), the activity log, and provider-call/billing records. The backfill CLIs run _after_ the drop - too late. No `backupDatabase` is wired before migrate.
- **Why it matters:** Irreversible production data loss triggered just by upgrading/restarting.
- **Fix:** Make these copy-old->new (or `alter table rename` + copy) before dropping, or have the migrator auto-`backupDatabase()` before any file containing `drop table`/`delete from`. Add a pre-migrate snapshot convention.

### 5. No CI and no linter/formatter - HIGH | DX / process

- **Files:** absent `.github/`; absent `.eslintrc*`/`prettier*`/`eslint.config.*`
- **What's wrong:** Nothing runs typecheck or tests on push/PR; the (broken, see #1) `build` script is the only gate and is manual. No ESLint means floating promises, dead code, and unsafe patterns (several found below) surface only at runtime.
- **Why it matters:** Every other issue here can regress freely. A linter would have caught the floating-promise and empty-catch issues directly.
- **Fix:** Add a GitHub Actions workflow: `npm ci` -> `typecheck` -> fixed test command -> `build:web` -> `docker build`. Add `typescript-eslint` + Prettier with a `no-floating-promises` rule and wire into CI.

### 6. Rate-limit identity is spoofable / globally shared - HIGH | security

- **Files:** `src/app-routes.ts:4112-4117` (`clientKey`), limits at `:114-119`
- **What's wrong:** With `PACKETAGENT_TRUST_PROXY` on, the limiter key is the client-controlled left-most `x-forwarded-for` value - rotate the header per request to get a fresh bucket and fully bypass the 20/min `auth:login`/`auth:register` limits (brute force). With it off (default), the key is the constant `"local"` - one shared bucket, so a single client can exhaust the login bucket and **lock out login for the whole instance** (DoS).
- **Why it matters:** Defeats credential-stuffing protection and enables a trivial login-lockout DoS.
- **Fix:** Parse XFF right-to-left stripping N trusted hops; without proxy trust use the real socket address; additionally key auth limits on the submitted email.

### 7. Scheduler can crash the process on an unhandled rejection - HIGH | bug

- **Files:** `src/jobs/scheduler.ts:96` (`void this.runJob(job)`), error path `:150-164`; `tick()` `catch {}` `:88-101`
- **What's wrong:** `runJob` is fired with `void` and **no `.catch`**; its failure-handling path `await`s unguarded store writes. If those reject (store down, JSON race per #3, DB locked) the rejection escapes and, under Node's default `unhandledRejection=throw`, **crashes the scheduler process**. Separately, `tick()`'s `catch { /* ignore */ }` swallows the HTTP coordinator's _intentional_ fail-closed 401/403 throw, silently degrading leader election to "never leader, no logs."
- **Why it matters:** Background job processing (alerts, metrics, session cleanup, exports) silently dies or crashes.
- **Fix:** `void this.runJob(job).catch(logRedacted)`; wrap terminal-status writes in try/catch; in `tick()`, log before rescheduling and rethrow/stop on the auth-fatal error class.

### 8. God files block review and concentrate merge risk - HIGH | code quality

- **Files:** `src/operations-status.ts` (5,069 L), `src/packetagent-store.ts` (4,941 L), `src/app-routes.ts` (4,176 L), `src/packetagent-services.ts` (3,771 L), `src/app-builder-service.ts` (3,255 L), `web/src/workbench/views/builder.tsx` (2,306 L)
- **What's wrong:** Each blends many responsibilities. `packetagent-store.ts` holds ~50 types + env resolution + 3 storage backends + inline SQL/DDL + 18 near-identical `*Dedicated*` persistence fns + 7 dual-write enqueue/flush pairs. `operations-status.ts` is ~3,000 lines of mechanically repeated phase-gate derivation. `packetagent-services.ts` ships 29 sync/`*Async` twins. `builder.tsx` is one 2,306-line React component with ~30 inline sub-components.
- **Why it matters:** Highest change-amplification and merge-conflict surface; effectively unreviewable and untestable as units.
- **Fix:** Mechanical extraction along existing seams - `store/{json,sqlite,postgres}-backend.ts` + a generic `persistCollection(descriptor)`; table-drive the phase gates; split `app-routes.ts` into `builder-/preview-/publish-routes.ts`; decompose `builder.tsx` into a `builder/` folder. No behavior change.

### 9. The deployment-governance subsystem is ~one-third of the codebase for an unbuilt feature - HIGH | architecture / overengineering

- **Files:** `src/deployment/` (~13 KLOC + ~11 KLOC tests), `src/operations-status.ts`, `release-readiness.ts:180-542`, `managed-database-runtime-guard.ts:20-71` (~226 `PACKETAGENT_MULTI_WRITER_*` references)
- **What's wrong:** A 14-stage "Phase 53-66 multi-writer runtime activation" gate state machine with 200+ env vars modeling human sign-off (`_RELEASE_OWNER_SIGNOFF`, `_ROLLOUT_WINDOW`, `_ABORT_PLAN`) - for a multi-writer Postgres mode the guard itself reports as not built. The only runtime consumer is one boot guard at `server.ts:421` that could be ~100 lines.
- **Why it matters:** Dwarfs the actual product (170-line scheduler, 147-line alert engine); enormous cognitive and maintenance load with no user-facing value; inflates the test/typecheck surface.
- **Fix:** Strip the Phase53-66 gate types and `MULTI_WRITER_*` evidence matrix; reduce the runtime guard to the boot-safety check actually used; drop the `deployment:export-evidence`/`check-release` CLIs in favor of a README env table. Reclaims ~one-third of `src`.

### 10. Unauthenticated artifact serving + dev-fallback preview-token secret - HIGH | security

- **Files:** `src/server.ts:410-414,452-457` (artifacts); `src/app-routes.ts:2232-2247` (`PREVIEW_TOKEN_DEV_FALLBACK_SECRET`)
- **What's wrong:** `/data/artifacts/*` is served via `serveStatic({ root: "./" })` with **no auth or workspace scoping**, and `artifactServingEnabled()` defaults **on** whenever `NODE_ENV !== "production"`; the broad `root` delegates traversal safety entirely to the static middleware. Separately, if neither `PACKETAGENT_PREVIEW_TOKEN_SECRET` nor `PACKETAGENT_MASTER_KEY` is set, preview-token signing falls back to a **constant baked into the source** (only `console.warn`), so anyone reading the repo can forge valid preview tokens for any `appId`.
- **Why it matters:** Cross-tenant artifact read access and forgeable preview links to other workspaces' generated apps.
- **Fix:** Scope `root` to the artifacts dir; require explicit enable regardless of `NODE_ENV`; add auth/tenant scoping. Refuse to issue/verify preview tokens in production when no real secret is configured. (The HMAC verification itself is otherwise solid.)

---

## C. Quick Wins (< 1 hour each, good impact)

1. **Fix the test glob** (#1) - quote the patterns in `package.json:68-70`. Single highest-leverage change in the repo.
2. **Fix README/SELF_HOST single-port instruction** - `npm start` runs _dev_ (vite 7341 + watch). Single-port serve is `npm run build:web && npm run start:server`. (`README.md:62-66,98`)
3. **Default sandbox driver to `docker` and fail closed** (#2 partial) - flip the `auto`->native fallback to throw; replace `{...process.env}` at `native-driver.ts:87` with an allowlist.
4. **Refuse the preview-token dev-fallback secret in production** (#10). (`app-routes.ts:2232-2247`)
5. **Add a top-level React `<ErrorBoundary>`** in `web/src/main.tsx` - currently any render throw white-screens the whole SPA (no boundary exists anywhere).
6. **Add the preview `<iframe>` `sandbox` + `title` attributes** (`builder.tsx:1647`) - a11y + the generated app currently runs with parent-origin privileges.
7. **`activities-repo.ts:218` - wrap `JSON.parse(row.payload)` in try/catch** like every sibling repo; one corrupt row currently breaks the whole activity feed.
8. **De-duplicate constants:** `DEFAULT_LIST_LIMIT`/`MAX_LIST_LIMIT` (agent-runs-read/jobs-read), and `*_TOPOLOGY_HINTS` / `DURABLE_JOB_EXECUTION_POSTURES` duplicated across `operations-status.ts` and `operations-health.ts`.
9. **`app-iteration-service.ts:970` - add the `g` flag** to the secret-redaction regex; today only the _first_ secret in a string is masked before being persisted.
10. **Remove/disable dead UI:** the non-wired runs search input (`runs.tsx:90`), the always-"All systems normal" topbar + dead bell (`Shell.tsx:143-144`), and the "coming soon" Alerts tab in nav (`admin.tsx:26-32`).
11. **Add `type="button"`** to non-submit buttons (65/100 lack it; risk of accidental form submit).
12. **Move `registerDefaultProviders()`/`registerDefaultTools()`** out of `server.ts` import-time (lines 78-79) into a `bootstrap()` so importing the module stops mutating global registries.

---

## D. Larger Refactors (grouped by priority)

**P0 - Correctness & safety**

- Serialize + atomically write the JSON store (#3); cache a single `pg.Pool` per process instead of opening/`end()`-ing one per operation (`packetagent-store.ts:1186-1209`).
- Make destructive migrations non-destructive + auto-backup before drops (#4); add foreign keys (`on delete cascade`) to the dedicated tables 0010-0018 (currently orphan rows survive workspace deletion); add `pragma integrity_check`/`foreign_key_check` to restore.
- Resolve the dual-representation `jobs` race: pick one writer for the `jobs` table (repo _or_ document store), or share a transaction - today `persistDedicatedJobs` (`packetagent-store.ts:2072`) can revert a just-claimed job to `queued` -> double execution.
- Enforce workspace scoping on write-side `jobs.update`/`upsert` and `find(id)` paths (currently id-only -> cross-tenant mutation, `jobs-repo.ts:314-335`).

**P1 - Finish or freeze the persistence migration**

- This single in-flight migration is the root of most code-quality debt: the 29 sync/`*Async` service twins, the ~8 `*-read.ts` facades, the parity/dual-write test families, and the 18+7 duplicated store functions all exist to bridge it. Declare the target backend done and delete the legacy sync/JSON read paths wholesale, _or_ collapse the boilerplate into one generic `createReadFacade<T>(descriptor)` and one `persistCollection(descriptor)`. Centralize backend selection behind a single `getStoreMode()` (12 scattered raw `process.env.PACKETAGENT_STORE` checks today).

**P2 - Shrink the surface**

- Delete the unbuilt Phase53-66 governance subsystem (#9). Split the remaining god files (#8). Introduce `src/config.ts` as the single env-reading boundary (55 `process.env` reads in non-test source, no central config module).

**P3 - Frontend**

- Decompose `builder.tsx` into per-tab files; introduce shared `<AsyncBoundary>` (loading/error/empty) and keyboard-accessible `<NavTab>`/`<ClickableCard>` (14 clickable `<div>`s lack `role`/`tabIndex`/key handlers); decide the styling story (Tailwind config is good but ~unused - 1,383 inline `style={{}}` vs 1,179 `className`); consider React Query/SWR to replace the cache-less `useApiData`.

**P4 - Production build**

- Replace shipping `tsx` to prod (`Dockerfile:37` runs raw `.ts`) with a `tsc`/esbuild build to `dist/` run by plain `node` - faster cold start, real type-check gate, smaller image, no source `.ts` shipped.

---

## E. Suggested Roadmap

**Phase 1 - Stabilize (make the build tell the truth)**

1. Fix the test glob (#1); triage resulting failures.
2. Fix sandbox fail-open + secret leak (#2).
3. Serialize/atomic JSON store writes (#3).
4. Guard destructive migrations + auto-backup (#4).
5. Add CI running typecheck + fixed tests + build:web + docker build (#5).
6. Quick wins C2, C4, C7, C9.

**Phase 2 - Clean up**

1. Add ESLint (`no-floating-promises`, `no-empty`) + Prettier.
2. Replace the 41 empty `catch {}` in source with a logged `swallow(err, ctx)` helper.
3. De-dup constants/utilities (C8, C10, frontend `formatRelative` x5).
4. Centralize env reads in `src/config.ts`; one `getStoreMode()`.
5. Fix docs inconsistencies (single-port, sandbox-driver default); add CONTRIBUTING + a working "how to run tests".

**Phase 3 - Improve architecture**

1. Decide the persistence migration's end-state; delete legacy paths or genericize the boilerplate (P1).
2. Delete the Phase53-66 governance subsystem (#9).
3. Split god files along seams (#8); decompose `builder.tsx` (P3).
4. Consolidate the model/provider catalog (3 catalogs can drift) and the 27 inline `server.ts` routes into modules.

**Phase 4 - Harden for production**

1. Rate-limit identity fix (#6); CORS + `secureHeaders()`/CSP (none today); container hardening (`--user`, `--cap-drop=ALL`, `--no-new-privileges`, `--pids-limit`, `docker-driver.ts` runs as root); sandbox timeout cap + per-workspace concurrency limit.
2. Artifact-serving auth/scoping + preview-token prod hardening (#10).
3. Runtime validation (zod) at every persistence read boundary (blind `as` casts everywhere today).
4. Real production build (P4); transactionally-consistent backups for all three backends (only SQLite has a backup command, and it's not consistent); non-destructive `backfill-managed-postgres` (currently full-replace that discards target-only rows).
5. e2e/smoke tests (auth -> generate -> serve -> publish); frontend component tests.

---

## F. Questions for the Repo Owner

1. **Persistence end-state:** Which backend is the strategic target - managed Postgres, SQLite, or all three indefinitely? The answer decides whether to _delete_ the dual-write/sync-twin/read-facade scaffolding or invest in genericizing it. This is the single biggest lever on code health.
2. **Multi-writer governance:** Is the Phase53-66 multi-writer activation feature actually planned, or is it abandoned scope? If abandoned, ~one-third of `src` can be deleted.
3. **Sandbox threat model:** Is the `native` (host-execution) driver intended only for trusted single-user local dev? Confirming this lets us fail closed everywhere without breaking a supported workflow.
4. **Default store for self-hosters:** The README/`.env.example` default is `sqlite` in Docker but `json` is selectable and unsafe under concurrency - should `json` be demoted to "single-user/dev only" and documented as such (or removed)?
5. **Upgrade path on existing data:** Have the `DROP TABLE` migrations (0012/0013/0015/0016) already shipped to any deployment with real data? This determines whether #4 is "prevent future loss" or "also need a recovery/forward-fix migration."
6. **The 266 uncommitted modified files** - is this an in-flight WIP branch state, or should these be committed/reverted before any of the above work begins? It affects what baseline we refactor against.
7. **Production build appetite:** Is shipping raw `.ts` via `tsx` an intentional simplicity choice, or acceptable to replace with a compiled `dist/`?

---

## Appendix - Detailed Findings by Review Area

> Cross-references to Section B issues in brackets. File:line references are precise.

**1. Project structure.** What it is and main components are covered in section A. Confusing/duplicated structure: two unrelated subsystems both named "sandbox" (`src/sandbox/` Docker drivers vs `src/tools/sandbox.ts` host shell tool); 27 routes defined inline in `server.ts:105-342` while siblings live in `*-routes.ts` modules (no consistent rule); the dual-write `*-read.ts` family is copy-paste boilerplate [#8, P1]. Top-level working tree contains stray `*.log` files (gitignored, untracked) and `.claude/worktrees/*` clutter (gitignored).

**2. Setup & DX.** `.env.example` is clear and `scripts/preflight.mjs` gives excellent first-run validation (probes the provider key against a live endpoint). Blockers for a new dev: the broken test command [#1], and the README telling them to run `npm start` for single-port serve when that launches dev mode (correct: `start:server`). No CONTRIBUTING.md. Sandbox-driver default documented inconsistently (`README.md:180` says `auto`; `.env.example:35`/compose say `docker`).

**3. Architecture.** Request flow: SPA -> `web/src/lib/api.ts` (cookie auth + `X-CSRF-Token` double-submit) -> vite proxy -> `accessLogMiddleware` -> `enforcePrivateAppMutationSecurity` (origin + CSRF on `/api/app/*`) -> handler -> `requirePrivateWorkspaceRoleAsync` (RBAC) -> service -> store. Store mode resolved by `resolvePacketAgentStoreMode` (`packetagent-store.ts:808`). Providers behind an `LLMProvider` port + `ProviderRouter`; sandboxes behind a `SandboxDriver`. Problems: oversized governance layer [#9], god files [#8], closed provider union requiring coordinated multi-file edits to add a provider, three drifting model catalogs.

**4. Code quality.** God files [#8]; 29 sync/`*Async` service twins (`packetagent-services.ts`); 18 `*Dedicated*` + 7 dual-write fn pairs in `packetagent-store.ts`; 41 empty `catch {}` in source (no logging -> invisible corruption); no central config (55 non-test `process.env` reads, `PACKETAGENT_STORE` checked raw in 12 places); module-level mutable singletons with `*ForTests` setters (smell that prod code isn't injectable); import-time side effects (`server.ts:78-79`).

**5. Bugs & correctness.** JSON store lost updates [#3]; scheduler crash/swallow [#7]; dual-write runs _after_ primary commit so a secondary-store failure both diverges the stores and reports the whole op failed (`packetagent-store.ts:902-945`; same in `alert-store.ts:163-289`); recurring-job re-enqueue swallows store errors -> recurrence silently stops (`scheduler.ts:144-149`); LLM tool-input null-deref escapes try/catch (`app-iteration-service.ts:1083`); `(error as Error).message` can itself throw on non-Error (`app-iteration-service.ts:1352`). The recent preview-token HMAC fix was verified **correct** (appId+expiry bound, length-checked `timingSafeEqual`).

**6. Security.** Confirmed: native-sandbox fail-open RCE + secret leak [#2]; rate-limit bypass/DoS [#6]; unauthenticated artifact serving + preview-token dev fallback [#10]; incomplete Docker hardening (runs as root, no `--cap-drop`/`--no-new-privileges`/`--pids-limit`, `docker-driver.ts:97-117`); sandbox DoS (24h max timeout, no concurrency cap, `sandbox-service.ts:246`); no CORS/security-headers/CSP (`server.ts:81-84`); static KDF salt in vault (`security/vault.ts:13`). Good practices: scrypt+salt passwords (`auth-utils.ts:10-23`), hashed-only sessions w/ TTL + cleanup job, AES-256-GCM secret vault refusing to boot without `MASTER_KEY` in prod, fully parameterized SQL throughout, a genuinely hardened (but currently _unused_ - see below) `path-validator.ts`, robust log redaction. **Note:** the hardened `validateWorkspacePath` (`codegen/path-validator.ts:69`) is imported only by its test; the live `write_file` path uses a weaker inline `isSafePath` (`codegen/llm-author.ts:101`) - wire the strong one in (one-import fix).

**7. Dependencies.** Single clean lockfile (`package-lock.json`, no yarn/pnpm). Versions current (React 19, Vite 7, hono 4.12, pg 8.20). No unused deps. `tsx` correctly in `dependencies` (prod runtime). `playwright` as optionalDependency is used in 8 files -> will throw at runtime where its install was skipped; guard call sites or make it required. `openai`/`@anthropic-ai/sdk` loaded via lazy `require()` inside ESM - invisible to typecheck/tree-shake; prefer typed dynamic `import()`.

**8. Testing.** [#1] is the dominant issue. Underlying coverage of stores/repos/dual-write/providers/jobs/deployment is genuinely strong - it just doesn't all execute. No e2e/integration; frontend ~untested (2 files, 1 of which doesn't run). First tests to add after the glob fix: full auth flow; sandbox native-guard + docker `--network=none --read-only`; RBAC cross-workspace denial; single-port production serve smoke; codegen path-traversal; provider failover; builder happy-path render; preflight unit test.

**9. Performance & scalability.** New `pg.Pool` per store op (no pooling, `packetagent-store.ts:1186-1209`); per-call `openDatabase()` re-runs the migration dir scan on every query (`jobs-repo.ts:538-549`); `jobs.claimNext` full-scans queued + sorts in JS, ignoring `idx_jobs_status_scheduled` (`jobs-repo.ts:352-365`); `provider_calls.list` drops the SQL LIMIT when `since` is set -> loads full partition (`provider-calls-repo.ts:195`); frontend fires uncached overlapping fetches (Dashboard fires 5), 1,383 inline style objects.

**10. Observability & operations.** Strong redaction layer and an extensive (over-extensive) operations-status/health surface. Weaknesses: 41 silent `catch {}` hide failures; scheduler swallows storage + auth errors (`scheduler.ts:88-101`) -> spins with no logs; only SQLite has a backup command and it's not transactionally consistent (`cli.ts:427-443`); no metrics/tracing beyond the bespoke status reports; `reset-db`/`reset-app` delete the live DB with no confirmation and leave `-wal`/`-shm` siblings (`cli.ts:573-610`).

**11. UI/UX.** Covered in P3 + quick wins. No error boundary; 2,306-line `builder.tsx`; 14 non-keyboard-accessible clickable `<div>`s; inconsistent loading/error handling (e.g. Dashboard ignores `activity.error`); preview iframe missing `sandbox`/`title`; dead/stub UI shipped in nav; three competing styling paradigms. Strong spots: `lib/api.ts`, `CommandPalette.tsx` (model a11y), `ToastContext`, `AuthPage`.

**12. Database/data.** Covered in [#4], P0, P4. Forward-only migrations tracked in `schema_migrations` (good), but destructive recreates with no rollback/backup; dedicated tables 0010-0018 dropped the FKs the `0003` originals had -> orphans on workspace delete; generic `app_records` doc model relies on hand-added expression indexes per query shape; no runtime validation at read boundaries (blind casts); `backfill-managed-postgres` full-replaces and discards target-only rows (`cli.ts:830`); missing `0002` migration (harmless gap). Note: numbered migrations 0012/0013/0015/0016 are the data-loss risk.

**13. Documentation.** README is thorough (24KB) and mostly accurate; `.env.example`, QUICKSTART, SELF_HOST, HANDOFF, SECURITY all present. Misleading: single-port `npm start` instruction; sandbox-driver default inconsistency. Missing: CONTRIBUTING, a working test command, and accurate "what runs in prod" (raw `.ts` via tsx).

**14. Build/CI/CD & deployment.** No CI [#5]; no lint/format; `build` runs the broken `test` [#1]; Docker ships `tsx` + source `.ts` and type-checks but doesn't run tests; `docker-compose` correctly fails fast on missing `MASTER_KEY`/`RATE_LIMIT_KEY_SALT`; raw `docker run` without those secrets crashes on boot (by design); docker sandbox needs `/var/run/docker.sock` mounted or all sandbox exec fails at runtime.
