# TaskLoom Repo Review — Running Notes

## High-level facts (verified)
- Project: `taskloom` v0.1.0, MIT, repo github.com/packetloss404/taskloom
- Node >=22.5.0, ESM (`"type": "module"`), TypeScript via `tsx` (no build/transpile step for API — runs `.ts` directly with `node --import tsx`)
- Backend: Hono + @hono/node-server. Frontend: React 19 + Vite 7 + React Router 7 + Tailwind 3 in `web/`
- LLM SDKs: @anthropic-ai/sdk, openai. DB: `pg`. Sandbox: optional `playwright`.
- 418 tracked files; 314 in src/ (305 .ts, 47 .tsx)
- Persistence: pluggable store — json | sqlite | postgres ("managed-postgres"). Dual-write / read-parity migration pattern in progress.

## Structure
- `src/` flat + subdirs: activation, alerts, codegen, db, deployment, jobs, providers, repositories, sandbox, security, tools
- `web/src/`: App.tsx, main.tsx, components, config, context, lib, pages, workbench
- `scripts/`: preflight.mjs, run.ps1, run.sh
- `dev/`: architecture, deployment/examples
- `docs/`: CODEGEN_FILETREE, HANDOFF, PHASE3_SCOPE, QUICKSTART, SELF_HOST, index.html
- `data/`: generated-apps, published-apps, taskloom.json (495KB local data, gitignored)

## RED FLAGS (initial)
- HUGE files (lines): operations-status.ts 5069, taskloom-store.ts 4941, app-routes.ts 4176, taskloom-services.ts 3771, release-readiness.ts 3431, app-builder-service.ts 3255, release-evidence.ts 2976, db/cli.ts 2515, operations-health.ts 2238
- NO CI: `.github/` absent. No GitHub Actions / pipeline.
- NO linter/formatter config (no eslint, prettier).
- Many `.claude/worktrees/agent-*` leftover (gitignored, not committed, but clutter on disk)
- Top-level log files present (taskloom-api.err.log 204KB etc.) — gitignored (not tracked) but left in working tree
- 266 modified files in working tree (uncommitted) — large in-flight change set
- `build` script runs typecheck+test (no API bundling); API ships as raw .ts run via tsx in Docker runtime (tsx in production)

## Areas to assign to agents
1. Architecture & structure
2. Security
3. Code quality / large files
4. Bugs / correctness
5. Frontend (web/)
6. DB / data / migrations
7. Testing
8. Deps / build / CI / DX / docs

## VERIFIED MYSELF (not just agent claims)
- TEST GLOB BUG (CONFIRMED): `find src -name '*.test.ts'` = 143 files. `sh -c 'src/**/*.test.ts'` expands to only 52. Top-level `src/*.test.ts` = 71 (NOT matched by the `**` pattern). ~91 test files silently skipped by `npm test`. Bash w/o globstar also = 52. => npm/sh runs the glob, `**`→`*`, only one subdir level matched.
- SANDBOX FAIL-OPEN (CONFIRMED): sandbox-service.ts:434 default driver `auto`; :454-456 auto falls back to native (host exec); :591 guard only blocks when NODE_ENV===production; native-driver.ts:87 `env:{...process.env,...}` leaks MASTER_KEY/provider keys into untrusted child.

## STATUS: review complete. Deliverable = REPO_REVIEW.md (A–F + 14-area appendix). No application code modified.
