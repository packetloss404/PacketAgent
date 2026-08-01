# R8 release reliability and production packaging

Status: complete. The R8 gate passed on 2026-08-01.

`BACKLOG.md` is the sole implementation ledger. This document records the
decisions, requirement-to-evidence map, and reproducible release commands.

## Outcome

R8 closes the release gap between what PacketAgent says, what its focused paths
exercise, and what its production image runs:

- every newly saved generated-app checkpoint has a versioned, checkpoint-bound
  smoke transcript;
- focused app and canonical Worker paths are assembled into one deterministic
  release command;
- the named traversal, preview, artifact, rollback, backup/restore, and tenant
  regressions are release-gated;
- production runs built Node 22 ESM JavaScript with source maps while
  Playwright remains optional and dynamically imported;
- unsupported release claims are scanned out of public and UI surfaces; and
- generated build/runtime evidence remains outside Git with an explicit,
  narrowly scoped cleanup command.

## Checkpoint quality transcripts

`packetagent.generated-app-smoke-transcript/v1` binds one record to exactly one
workspace, app, and checkpoint. It records:

- the operation source: approval, iteration, preview refresh, rollback, or
  branch;
- pending/pass/warn/fail status, a bounded summary, bounded checks, and bounded
  blockers;
- whether validation ran in the isolated sandbox or was not run;
- validator source when supplied; and
- start/completion/recorded timestamps plus non-negative duration.

Initial approval and applied iteration persist the transcript atomically with
the checkpoint. Preview refresh now resolves the requested historical
checkpoint instead of silently validating the current draft, then updates that
exact checkpoint's transcript. Rollback and branch copy identical source from a
prior checkpoint and create a new derived transcript with
`derivedFromTranscriptId`; they do not claim a second sandbox execution.
Legacy checkpoints may omit the optional field. If one is rolled back or
branched, PacketAgent creates an honest pending compatibility transcript when
no earlier transcript exists.

The Checkpoints UI shows the transcript status, runner, duration, record ID,
and timestamp. Raw secrets are not accepted by or added to this schema.

## Release evidence matrix

| Requirement                                        | Automated evidence                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign in                                            | `verify-workbench-browser.mjs` submits the real sign-in UI against a temporary SQLite server.                                                                                                                                                                                                    |
| Build and approve an app                           | Focused `builder app draft can be generated and applied with smoke metadata` route test.                                                                                                                                                                                                         |
| Inspect checkpoint evidence                        | Apply/list tests verify the persisted transcript and checkpoint binding; the JSON/SQLite/managed-Postgres lifecycle parity scenario reloads it identically; the browser/component suite covers its presentation primitives.                                                                      |
| Iterate and roll back                              | Focused iteration/apply/rollback route test plus snapshot rollback contract cases.                                                                                                                                                                                                               |
| Preview                                            | Generated preview route case, origin/capability isolation cases, and the built-browser Builder surface.                                                                                                                                                                                          |
| Publish                                            | Focused self-hosted publish/history/compose/log/rollback route test plus manifest v2 integrity/tamper cases.                                                                                                                                                                                     |
| Deploy, run, inspect, reconnect, and stop a Worker | The serialized PacketADE handoff gate validates, deploys, activates one queued run, disconnects SSE, reconstructs from serialized durable state, inspects, resumes from the acknowledged cursor, updates, pauses/resumes, rolls back, and revokes. Revoke is the deployment-level stop boundary. |
| Path traversal                                     | All 25 generated workspace path-validator cases.                                                                                                                                                                                                                                                 |
| Artifact validation                                | Generated-app manifest file/static-graph/digest/signature cases, including changed and unexpected files.                                                                                                                                                                                         |
| Backup and restore                                 | Successful stopped-service SQLite round trip and corrupt-foreign-key backup refusal without replacing the current DB.                                                                                                                                                                            |
| Tenant isolation                                   | Generated source-route workspace isolation and observability restart/rollup workspace isolation.                                                                                                                                                                                                 |
| Documentation truth                                | `verify-documentation.mjs` checks all tracked Markdown files, local links and screenshots, documented npm commands, historical labels, completed-loop authority statements, and the single conditional unchecked backlog item.                                                                   |
| Public claim truth                                 | `audit-release-claims.mjs` scans public setup and production source/UI files for unsupported future, fake-success, demo-only, old phase-TODO, and public stub-provider wording.                                                                                                                  |

The PacketADE live-network test and PacketChat/PacketPhone live delivery probes
remain conditional because no external endpoints or credentials are configured.
Their local contract, restart, race, replay, rotation, and dead-letter gates
remain shipped; R8 does not turn a local adapter gate into an external product
certification claim.

## Production packaging decision

The spike passed, so the production entry point is built JavaScript:

- `scripts/build-server.mjs` bundles `src/server.ts` and the generated-app
  runtime worker as split Node 22 ESM outputs in `dist/`;
- every JavaScript output has an external source map with source content;
- the generated-app publish runtime asset is copied into `dist/` and the build
  manifest inventories entry points, outputs, maps, and optional imports;
- `npm start` runs `node --enable-source-maps dist/server.js`;
- `npm run start:dev-server` is the explicit source/tsx path; and
- the generated-app runtime chooses the built worker when called from the
  compiled server and retains the source worker during development.

Migration SQL and validation-image resources resolve from the repository/image
root, so code splitting does not make them depend on a generated chunk's
`import.meta` path. The image retains `src/` for supported maintenance CLI
commands, but PID 1 executes the built server.

`npm run verify:production-build` checks the manifest, source maps, copied
runtime asset, dynamic Playwright import, and a real plain-Node readiness boot.
`npm run verify:production-image` builds the Dockerfile, inspects its exact
command, and boots it non-root with a read-only root filesystem before deleting
the temporary verification container and image. The 2026-08-01 gate passed.

## Browser evidence and generated artifacts

`npm run verify:workbench-browser` uses the installed optional Playwright
package and Chromium. It writes two review screenshots:

- `tmp/release-verification/builder-app-mode.png`
- `tmp/release-verification/worker-operations-mode.png`

Reviewed copies are committed as `docs/assets/readme/builder-app-mode.png` and
`docs/assets/readme/worker-operations-mode.png` for the README. The
documentation gate verifies both targets exist, are nontrivial, and carry a
PNG signature.

`tmp/`, `dist/`, `web/dist/`, coverage, exported packages, runtime artifacts,
generated-app workspaces, and published-app workspaces are ignored by Git.
Use:

```bash
npm run clean:generated
```

That command removes only the explicitly listed generated roots. It does not
remove `data/packetagent.json`, SQLite databases, environment files, or other
operator state. State reset is a separate, intentional action:

```bash
npm run store:reset
PACKETAGENT_STORE=sqlite npm run db:reset
```

Stop PacketAgent and take a backup before using a state-reset command.

## Reproducible gates

```bash
npm run verify:docs
npm run verify:release
npm run verify:production-image
npm run typecheck
npm run lint
npm run format:check
npm run test:api
npm run test:web
```

`verify:release` runs 13 deterministic groups: documentation truth, web/server
builds, the focused app path, the Worker disconnect/reconnect path, smoke transcript unit coverage,
checkpoint storage parity, the named regression families, backup/restore,
tenant isolation, release-claim audit, built-server boot, and the real-browser path. Docker image verification
is separate so contributors without a daemon can still run deterministic
source/build gates; it is required before a production release.

Gate conclusion: the release checklist, built server, actual production image,
backup round trip, browser/app/Worker paths, and public claims describe the
same tested self-host product. The full repository suites close at 1,662 API
tests (1,659 passed, 3 intentionally skipped live probes, 0 failed) and 58 web
tests (all passed). R8 is complete.
