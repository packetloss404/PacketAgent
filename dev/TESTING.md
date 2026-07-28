# Manual Test Plan

End-to-end test plan run before cutting a release. Covers the builder loop, agent loop, workspace setup, providers, sandbox, operations, self-host publish handoff, and the backup round-trip.

This plan verifies the inherited workbench plus W2's durable Worker lifecycle,
W3's trigger-intake boundary, and W4's bounded supervisor. Full checkpoint
recovery, effect safety, and PacketADE handoff cases must be added as W5-W9
ship; they are not current product claims.

Last automated W4 baseline (2026-07-27):

- API: 1,336 passed, 1 skipped, 0 failed
- Web: 25 passed, 0 failed
- Focused Worker activation, supervisor, lease/revision, scheduler, and
  JSON/SQLite/managed-Postgres parity checks: passed
- Typecheck: passed
- Production web build: passed
- ESLint: 0 errors, 146 inherited warnings

See [`CODEX-HANDOFF.md`](CODEX-HANDOFF.md) for the full repository state.

Estimated time: 25-35 minutes for a full pass; about 10 minutes for the golden path.

## Prerequisites

- Node `>=22.5.0` and npm.
- Optional: a running Docker daemon so the sandbox driver reports `docker` rather than the insecure `native` fallback.
- Clean working tree.

```bash
npm install
npm run store:seed    # default JSON store; creates seed accounts and workspaces
```

When testing SQLite specifically, set `PACKETAGENT_STORE=sqlite`, then run `npm run db:migrate` and `npm run db:seed` before booting the app.

Seed accounts (all password `demo12345`):

| Email                     | Workspace | Role  |
| ------------------------- | --------- | ----- |
| `alpha@packetagent.local` | alpha     | owner |
| `beta@packetagent.local`  | beta      | owner |
| `gamma@packetagent.local` | gamma     | owner |

To wipe state between full passes:

```bash
npm run store:reset    # JSON store at data/packetagent.json
PACKETAGENT_STORE=sqlite npm run db:reset
```

Boot the app:

```bash
npm run dev
```

Open `http://localhost:7341/` in development, or `http://localhost:8484/` after `npm run build:web && npm start`.

## W2 Worker Lifecycle Smoke

Use an authenticated API client for `/api/app/workers`. Browser-originated
mutations must also send the existing PacketAgent CSRF cookie/header pair.

1. As a member, create a definition at `POST /api/app/workers/definitions` with a bounded W1 `content` object, PacketAgent source provenance, and an `Idempotency-Key` header.
2. Replay the identical request with the same key. Confirm the original definition/version IDs return and no duplicate event appears.
3. Validate the version using its `contentDigest`, then create, validate, and deploy a deployment using the returned revision at each step.
4. As an admin, activate, pause, resume, and retire the deployment. Confirm each response increments `revision` exactly once.
5. Create and activate a newer validated version, then roll it back to the older version. Confirm the old deployment retires, a new version-pinned deployment appears, and the rollout links predecessor to successor.
6. Reuse an idempotency key with changed input and submit one stale digest/revision. Confirm stable `idempotency_mismatch` and `conflict` responses.
7. Restart PacketAgent and read the definition plus `/events`. Confirm lifecycle state and monotonically increasing event sequence persist.
8. Repeat once with `PACKETAGENT_STORE=sqlite`; run the managed-Postgres parity test before release when that mode is supported by the deployment.

## W3 Worker Activation Smoke

W3 ends at durable admission. A successful delivery creates a queued
`WorkerRun` and `worker.run` execution job; W4's scheduler handler now claims
and executes that job through the bounded supervisor.

1. Activate a deployment whose validated version contains enabled manual, cron, webhook, alert, and queue triggers with an input schema compatible with each test payload.
2. Manual: `POST /api/app/workers/deployments/:deploymentId/runs` with an `Idempotency-Key`, `triggerId`, and `input`. Confirm `202`, one activation inbox record, one queued run, and one execution job.
3. Replay that request byte-for-byte with the same key. Confirm the original run/job IDs return and `duplicateCount` increments. Change the input under the same key and confirm `idempotency_mismatch`; use a new key and confirm a distinct run.
4. Webhook: `POST /api/public/webhooks/workers/:webhookRef` with JSON plus `X-PacketAgent-Delivery-Id`. Replay the same delivery ID, then change the body under that ID. Confirm the same duplicate/conflict behavior while the legacy `/agents/:token` webhook still works.
5. Cron: run the Worker cron projector or wait for its minute job. Confirm one future `worker.activate.cron` job per active trigger, including its IANA timezone. Pause the deployment and confirm the projector cancels its queued occurrence.
6. Alert: emit a matching operations alert. Confirm the `alertEvents` record exists before the Worker activation and the alert event ID becomes the activation delivery ID.
7. Queue: call the queue adapter with the deployment, trigger, configured `queueRef`, and upstream message ID. Confirm that message ID is preserved as the delivery identity.
8. Send a valid `traceparent`/`tracestate` on manual or webhook intake and confirm its trace/span values are retained. Omit the headers and confirm a new valid trace is generated.
9. Include a sensitive field such as `api_key` or a payload larger than 32 KiB. Confirm the inbox and run hold an encrypted, expiring payload reference, workspace export omits ciphertext, and no raw value appears in events or jobs.
10. Restart PacketAgent and confirm inbox, duplicate count, queued run, execution job, and payload-reference metadata reload. Repeat the automated parity scenario for JSON, SQLite, and managed Postgres before release.

## W4 Bounded Worker Supervisor Smoke

W4 executes admitted runs but intentionally stops short of W5's full restart
recovery and external-effect receipts.

1. Activate a Worker with one declared objective-satisfied exit predicate, a read-only test tool, and small positive time, iteration, provider-cost, failure, retry, and tool-call limits.
2. Confirm the `worker.run` job moves the version-pinned run from `queued` to `running`, acquires an owner/expiry/fencing lease, and emits supervisor events without exposing prompt, tool output, or exit evidence.
3. Return one planned tool call, a successful tool result, and a valid evaluation JSON object. Confirm the run advances plan -> act -> evaluate -> checkpoint -> decide, appends a cursor checkpoint, increments its optimistic revision, and completes with an explicit predicate terminal reason.
4. Script endless tool requests, a provider that never settles, repeated provider errors, invalid evaluation JSON, exact provider-cost exhaustion, and an iteration with no matched predicate. Confirm every case reaches a finite terminal or release outcome and provider/tool call counts stay within the pinned limits.
5. Request cancellation during each phase and while a provider ignores its abort signal. Confirm no later tool starts and the owned run terminates as `operator_cancelled`.
6. Revoke the deployment during execution. Confirm the supervisor observes the durable deployment state before another action and terminates the owned run as `deployment_revoked`.
7. Let a lease expire and acquire it from a second owner. Confirm the fencing token increases monotonically, stale event/checkpoint/terminal writes conflict, and the stale supervisor performs no later tool or terminal write.
8. Stop the scheduler while a Worker job is claimed. Confirm the signal reason releases both the runtime lease and job claim, returns the job to `queued`, and does not consume an attempt or report success.
9. Repeat acquire, checkpoint, and terminal persistence across JSON, SQLite, and managed Postgres. Confirm identical terminal status, checkpoint count, run revisions, and no active lease on the terminal run.

## First 10 Minutes: Self-Host Builder Smoke

Use this as the short confidence pass when time is tight.

1. Run `npm install && npm run dev`.
2. Sign in at `http://localhost:7341` with `alpha@packetagent.local` / `demo12345`.
3. Open `/builder`, choose **Build an app**, and submit `Build a lightweight CRM for renewal tracking`.
4. Confirm the draft shows generated source: page routes, API routes, data model, acceptance checks, and open questions.
5. Approve the draft. Confirm the **Generated source** tab lists source files and a workspace path under `data/generated-apps/<workspace>/<app>/workspace`.
6. Open the preview route and confirm it serves `/api/app/generated-apps/:appId/preview`, including nested generated files such as `src/App.tsx`.
7. Open **Publish handoff**. Confirm it shows local package/runtime details, artifact paths, workspace manifest, health/smoke expectations, and next actions. It must not claim a cloud deployment unless a validated handoff URL and publish history entry exist.
8. Optional single-port serve: run `npm run build:web && npm start`, then open `http://localhost:8484`.

## Golden Path: Build An App

Sign in -> `/builder` -> describe an app -> saved local preview -> iterate -> publish handoff.

1. From the unauthenticated sign-in entry, submit `alpha@packetagent.local` / `demo12345`.
2. Confirm you land on `/builder`. The Build mode toggle should show **Build an app** selected.
3. Type a prompt such as `Build a lightweight CRM for renewal tracking`, then click the primary generate action.
4. Confirm a draft renders before any mutation. It should show app name, summary, plan steps, page map, data model, acceptance checks, and warnings/open questions when relevant.
5. Approve the draft. Confirm a new app and checkpoint are created and that a local preview path appears.
6. Open the preview link. You should land at `/builder/preview/<workspaceId>/<appId>/...` and see the generated routes load.
7. Submit a refinement prompt such as `Add an inline notes field to Account`. Confirm a dry-run change set is shown before mutation, including affected artifacts, route/privacy changes, acceptance checks, and rollback target.
8. Apply the change. Verify a new checkpoint is recorded and that the previous checkpoint is still listed in builder history.
9. Restore a previous non-current checkpoint from the history panel. Confirm the current pointer, preview state, and build/smoke metadata update.
10. Open the publish handoff area. Walk through readiness; confirm missing provider keys, webhook secrets, or base URLs are named by env key without exposing values, and that handoff remains private until required checks pass and the user explicitly approves public visibility.

Expected results:

- All builder calls hit `POST /api/app/builder/app-draft`, `POST /api/app/builder/app-draft/apply`, and the iteration / rollback endpoints with no console errors.
- Build/smoke status is visible at every stage, even when status is `not_run`, `blocked`, or `failed`.
- UI copy distinguishes generated source files, saved local preview, and publish handoff. It must not say the app is fully deployed unless a real URL/runtime artifact is present in publish state.
- No webhook tokens, API keys, or provider secrets are rendered in full.

## Agent Path: Build An Agent

Same golden flow, but for an agent with a schedule trigger, a webhook trigger, and a manual run.

1. From `/builder`, switch the build mode to **Build an agent**.
2. Type `Create a support triage agent that summarizes new tickets and drafts a reply`. Generate the draft.
3. Verify the draft preview includes name, description, instructions, input schema, recommended trigger, schedule or webhook recommendation, tools, provider/model, starter playbook, sample input, acceptance checks, and readiness warnings.
4. Approve the agent. The save call hits `POST /api/app/builder/agent-draft/approve`.
5. Edit the saved agent: add a webhook trigger via the agent editor (`/agents/:id`). Confirm the webhook URL and secret are shown but the secret is masked or revealable behind an explicit reveal.
6. Add or confirm a schedule trigger (cron expression). Confirm the schedule is shown in the agent overview.
7. Trigger a manual run from the builder run panel or `/runs`. Verify the run appears with transcript, tool calls, output, logs, model/cost, and a status pill.
8. From `/runs/<id>`, retry the run. Confirm a new run is created and that retry events flow through to activation (an `agent.run.retry` activity is recorded).
9. Trigger the webhook with `curl` against the webhook URL using the configured secret. Confirm a new run is created with `trigger=webhook` metadata.

Expected results:

- Manual, schedule, and webhook triggers each produce a run record visible at `/runs`.
- The retry path is idempotent for the same source run (no duplicate activation signal counts).
- Webhook tokens and API keys are never rendered in full.

## Workspace Setup

Onboarding stages live in `onboardingStates` and progress through:

| Step                       | Effect on activation facts                                |
| -------------------------- | --------------------------------------------------------- |
| `create_workspace_profile` | sets `briefCapturedAt`                                    |
| `define_requirements`      | sets `requirementsDefinedAt`                              |
| `define_plan`              | sets `planDefinedAt`                                      |
| `start_implementation`     | sets `implementationStartedAt`, `startedAt`               |
| `validate`                 | sets `testsPassedAt`, `validationPassedAt`, `completedAt` |
| `confirm_release`          | sets `releaseConfirmedAt`, `releasedAt`                   |

In a private window, sign up a fresh account at `/sign-up`. Walk through each onboarding step from the dashboard or activation view and confirm:

1. The dashboard "activation steps complete" counter increments.
2. The `/activation` view stage label moves through Discovery -> Definition -> Implementation -> Validation -> Complete as expected.
3. `GET /api/app/activation` and `GET /api/activation/:workspaceId` reflect the same status.
4. Sign-out returns to the unauthenticated sign-in entry.

Reset between passes by deleting `data/packetagent.json` or running `npm run store:reset` for the JSON store. For SQLite, run `PACKETAGENT_STORE=sqlite npm run db:reset`.

## Provider Configuration

1. Sign in as `alpha@packetagent.local` and visit `/integrations`. The breadcrumb reads "Providers".
2. Confirm the page lists configured model providers with one of: `connected`, `missing_key`, or another status pill.
3. Click **Add provider**. Add an Anthropic, OpenAI, or Ollama key.
4. Save and refresh. The new provider should now show `connected`. The status counter at the top of the page should update.
5. Verify the key is stored in the workspace vault, never echoed back. Re-opening the row should show only a redacted preview.
6. Switch to the **Tools** section and confirm the tool registry renders. Switch to **Environment** and confirm env vars render with secret values masked.

Optional: open `/builder` and re-run an app draft. The provider readiness section should now report the configured provider.

## Sandbox

1. Visit `/sandbox`.
2. Confirm the status panel shows the active driver. With Docker running it reports `docker`; without Docker it falls back to `native` and is marked insecure.
3. List sandbox runtimes. Pick a ready runtime in the composer.
4. Run `echo hello sandbox` with working directory `/workspace`. Confirm the run appears in the executions table with status `success` and exit code `0`, and that stdout shows `hello sandbox` in the selected exec panel.
5. Run a long sleep (`sleep 30`) and click cancel. Confirm the run transitions to `canceled`.
6. Filter the executions table by `failed` and `success` to confirm filters work.

Optional smoke integration:

1. Stop the dev server.
2. Set `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1` and restart.
3. Sign in and apply an app draft from `/builder` with smoke checks enabled.
4. Verify the smoke section names the sandbox driver. If the sandbox is unavailable, confirm fallback smoke status is explicit and actionable.

## Operations Sanity

1. Visit `/operations`.
2. Confirm subsystem health renders. Subsystems should be `ok`; degraded or `down` entries warrant investigation before release.
3. Confirm the alert list. Active alerts should be zero unless the release is deliberately introducing one.
4. Confirm job metrics render with last duration, average, p95, and 24h counts. Look for stuck queues (`count24h > 0` but `lastMs` older than expected).
5. Visit `/storage`, `/backups`, and `/releases`. Confirm each renders without errors.
6. Visit `/settings` -> **Audit** tab. Confirm recent activity entries are present.

Run from the command line:

```bash
npm run jobs:recompute-activation         # refreshes activation read models
npm run jobs:repair-activation            # refreshes stale read models
PACKETAGENT_STORE=sqlite npm run db:status   # inspects pending SQLite migrations
```

Each should exit `0` with no warnings.

## Self-Host Sanity

SQLite backup -> restart -> restore -> confirm data round-trips. Use this section when `PACKETAGENT_STORE=sqlite`.

1. With seed data loaded, run:

   ```bash
   PACKETAGENT_STORE=sqlite npm run db:backup -- --backup-path=data/packetagent.sqlite.bak
   ```

2. Confirm a backup file is written.
3. Stop the server. Modify the database (sign in, create an app draft, apply it).
4. Run the restore:

   ```bash
   PACKETAGENT_STORE=sqlite npm run db:restore -- --backup-path=data/packetagent.sqlite.bak
   ```

5. Restart the server and sign in. Confirm the app draft created in step 3 is gone and the seed data is restored exactly.
6. For the JSON store path, repeat with `npm run store:reset` to confirm `data/packetagent.json` resets to the built-in seed state on next start.

## Build And Tests

Run the layers relevant to the change being shipped:

```bash
npm run typecheck
npm run test:api
npm run test:web
npm run build
```

Acceptance:

- Each command exits `0`.
- No new TypeScript errors.
- A production bundle exists under `web/dist/` after `npm run build:web` or `npm run build`. Do not commit it.

## Public Share And 404

1. Generate a share token from `/settings` -> **Share tokens**.
2. Open `/share/<token>` in a private window. Confirm it renders without auth, hides the workbench sidebar, and exposes a sign-in link.
3. Visit an unknown route such as `/this-does-not-exist`. Confirm a styled 404 renders and the primary recovery action returns signed-in users to `/builder` and signed-out users to `/`.

## Command Palette

1. Press **Cmd+K** or **Ctrl+K** in any signed-in view.
2. Confirm the modal opens, typing filters entries, and arrow keys + enter + escape work.
3. Confirm builder and new-build entries are prominent and Advanced operations entries are present but grouped under Advanced.

## Bug Capture

If an acceptance line fails, capture the network request/response and browser console output. Reference the section name in the bug title, for example `Manual Test - Provider configuration: key save returns 500`.
