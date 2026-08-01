# Contributing to PacketAgent

PacketAgent is MIT-licensed and self-hosted. The canonical repository is
`git@github.com:packetloss404/PacketAgent.git`. Start with the root
[`HANDOFF.md`](../HANDOFF.md) when opening a new working session; use
[`CODEX-HANDOFF.md`](CODEX-HANDOFF.md) for the detailed implementation
inventory.

## Getting started

Requires Node 22.5 or newer.

```bash
cd /path/to/PacketAgent
npm ci
npm run dev
```

The current Windows checkout is `D:\projects\PacketAgent`. Confirm that the
active branch is `codex/packetagent-foundation` and that `taskloom-source` is
the only remote. Do not push to that historical remote.

Two processes start in parallel:

| Port   | Process    | Purpose                                                                  |
| ------ | ---------- | ------------------------------------------------------------------------ |
| `7341` | Vite (web) | React workbench at <http://localhost:7341>; proxies `/api/*` to the API. |
| `8484` | Hono (api) | REST + SSE endpoints, scheduled jobs, sandbox driver.                    |

Open <http://localhost:7341> and sign in with one of the seeded development accounts. Password is `demo12345` for all three.

- `alpha@packetagent.local`
- `beta@packetagent.local`
- `gamma@packetagent.local`

These credentials are dev-only - do not enable them in any deployment that anyone outside your laptop can reach. To wipe local state and restart from a clean seed, stop the dev server and run `npm run store:reset`.

## Codebase layout

| Path                                          | What lives there                                                                                                                                                                                           |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server.ts`                               | Hono entrypoint; mounts every route module.                                                                                                                                                                |
| `src/*-routes.ts`                             | HTTP route handlers, one module per surface (`app-routes.ts`, `auth-session-workspace-onboarding-routes.ts`, `webhook-routes.ts`, `sandbox-routes.ts`, `health-routes.ts`, `operations-*-routes.ts`, ...). |
| `src/*-service.ts`                            | Domain services that the routes call into (`app-builder-service.ts`, `app-iteration-service.ts`, `app-publish-service.ts`, ...).                                                                           |
| `src/agent-templates.ts`                      | Six built-in agent templates surfaced in the workbench gallery.                                                                                                                                            |
| `src/integration-marketplace.ts`              | Integration registry.                                                                                                                                                                                      |
| `src/db/`, `src/jobs.ts`, `src/jobs/`         | Persistence + job queue.                                                                                                                                                                                   |
| `src/deployment/`                             | Managed-database startup and runtime guards.                                                                                                                                                               |
| `web/src/App.tsx`, `web/src/main.tsx`         | React workbench entrypoint.                                                                                                                                                                                |
| `web/src/workbench/views/`                    | One file per workbench screen - `builder.tsx`, `agents.tsx`, `runs.tsx`, `run-detail.tsx`, `workflows.tsx`, `integrations.tsx`, `operations.tsx`, `secrets.tsx`, `webhooks.tsx`, `sandbox.tsx`, etc.       |
| `web/src/lib/api.ts`                          | Single typed API client used by every view.                                                                                                                                                                |
| `web/src/index.css`, `web/tailwind.config.js` | Theme tokens and class primitives.                                                                                                                                                                         |

Test files sit next to the code they exercise:

- API tests: `src/**/*.test.ts`, run under `node --test` via `tsx`.
- Web tests: `web/src/**/*.test.tsx`, run under the same harness.

## Running tests

All scripts are defined in [`package.json`](../package.json).

```bash
npm test           # API + web tests
npm run test:api   # API tests only
npm run test:web   # Web tests only
npm run typecheck  # tsc --noEmit for both tsconfigs
```

For the full repository gate (web/server bundles + typecheck + tests), run:

```bash
npm run build
```

R8 also provides a focused release-path gate and actual image proof:

```bash
npm run verify:release
npm run verify:production-image  # requires Docker
```

Prettier and ESLint are clean gates. Do not introduce or hide a new baseline.

## Building

`npm run build:web` produces the static workbench at `web/dist/`, and
`npm run build:server` produces Node 22 ESM plus source maps at `dist/`.
`npm start` runs the built server. Both output directories are gitignored;
rebuild locally rather than committing them.

```bash
npm run build:web
npm run build:server
npm start          # serves API + bundled web on :8484
```

## Style and conventions

- **TypeScript strict** everywhere. No `any` without a comment explaining why.
- **Hono routes** live in `src/*-routes.ts`. Keep handlers thin and push logic into a sibling `*-service.ts` so it can be tested directly.
- **React workbench** is React 19 + Vite, mounted at `/`. New screens go in `web/src/workbench/views/` and are wired through the existing router.
- **Theme**. Silver / grey / green-light, defined in `web/src/index.css` and `web/tailwind.config.js`. Reuse the existing class primitives instead of inventing one-off styles:
  - `.kicker`, `.kicker-amber` - small uppercase section labels.
  - `.btn-primary`, `.btn-ghost` - the two button variants.
  - `.pill` (with `.pill--good`, `.pill--warn`, `.pill--danger`, `.pill--info`, `.pill--muted`) - status chips.
  - `.field`, `.label` - form input + label pair.
  - `.spec-frame`, `.spec-frame--tight` - card surface used across the workbench.
  - `.tabbar` + `.tab` (and `.tab-strip` / `.tab-strip__item` for the alternate variant) - tabbed navigation.
- **No new dependencies** without an explicit design reason recorded with the
  change. The dependency list in `package.json` is intentionally small.
- **Tests are required** for new behaviour. Co-locate them with the code (`foo.ts` -> `foo.test.ts`).

## Publishing changes

1. Create a local `codex/*` topic branch from the intended base unless the
   repository owner explicitly requests direct integration on `main`.
2. Make the change and add or update tests.
3. Run the proportional gates, then `npm run build` before publication.
4. Confirm `origin` is `git@github.com:packetloss404/PacketAgent.git` before
   pushing or opening a PR. Never force-push `main`.

Commit messages: subject in imperative mood, under 70 characters; body explains the _why_ (what problem this solves, what alternatives were considered) rather than restating the diff. Squash trivial fixups before opening the PR.

## Reporting issues

Use the PacketAgent GitHub issue tracker when it is enabled. Until then, record
only owner-approved follow-on work in `BACKLOG.md`. Include the PacketAgent
version, Node version, OS, and reproduction steps. Follow `SECURITY.md` for
vulnerabilities.
