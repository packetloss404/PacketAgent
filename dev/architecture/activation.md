# Activation Engine

> **Scope note:** This inherited subsystem measures workspace onboarding and
> release adoption. It is not the canonical Worker deployment/trigger
> lifecycle shipped through W1-W3. Worker activation code uses explicit Worker
> terminology and must not overload this read model.

Activation is the system that promotes a workspace from a fresh sign-up through the work that proves it is in real use, ending at a confirmed release. It is driven by observed signals such as workflow records, agent runs, completed plan items, and release confirmations rather than self-reported steps. The pure engine derives a status DTO from a normalized snapshot, and a small services layer maps the live store into that snapshot and persists the resulting read model.

## Conceptual Model

A workspace has one activation track, identified by a `subjectType` of `workspace` and the `workspaceId` as `subjectId`. The track moves through a stage machine driven by what the system can observe:

| Stage            | Reached when                                                                       |
| ---------------- | ---------------------------------------------------------------------------------- |
| `not_started`    | No activation signals are present.                                                 |
| `discovery`      | A brief has been captured.                                                         |
| `definition`     | Requirements or a plan are defined.                                                |
| `implementation` | Implementation has started, or `startedAt` is set.                                 |
| `validation`     | Validation evidence exists, or implementation is complete.                         |
| `complete`       | Release evidence exists, or `releasedAt` is set.                                   |
| `blocked`        | Active blockers or dependency blockers are present. (Wins over every other stage.) |

Stage precedence runs: `blocked` > `complete` > `validation` > `implementation` > `definition` > `discovery` > `not_started`.

The same snapshot also drives a small **milestone log** (append-only `intake_ready` -> `released`, plus a `blocked` flag) and a five-item **checklist** that the workbench renders. Risk is calculated from the same inputs.

The pure engine has no IO. Adapters and services in `src/packetagent-services.ts` and `src/packetagent-store.ts` build the snapshot, persist the read model, and expose it over HTTP and the workbench.

## Domain Shape

The pure domain lives in `src/activation/` and has no runtime dependencies beyond TypeScript. Every type is exported through `src/activation/index.ts`.

### Subject reference

```ts
export interface ActivationSubjectRef {
  workspaceId: string;
  subjectType: string;
  subjectId: string;
}
```

`packetagent-services.ts#toSubject(workspaceId)` returns `{ workspaceId, subjectType: "workspace", subjectId: workspaceId }`. The engine does not know that workspaces are the only subject; the schema is generic for future subject types.

### Signal snapshot

```ts
export interface ActivationSignalSnapshot {
  now: string;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
  releasedAt?: string;
  hasBrief: boolean;
  hasRequirements: boolean;
  hasPlan: boolean;
  hasImplementation: boolean;
  hasTests: boolean;
  hasValidationEvidence: boolean;
  hasReleaseEvidence: boolean;
  blockerCount: number;
  dependencyBlockerCount: number;
  openQuestionCount: number;
  criticalIssueCount: number;
  scopeChangeCount: number;
  failedValidationCount: number;
  retryCount: number;
}
```

Every derivation reads only this snapshot. Boolean signals drive stage and milestone detection; numeric counts drive risk.

### Status DTO

```ts
export interface ActivationStatusDto {
  subject: ActivationSubjectRef;
  stage: ActivationStage;
  risk: ActivationRisk;
  milestones: ActivationMilestoneRecord[];
  checklist: ActivationChecklistItem[];
}
```

`deriveActivationStatus(subject, snapshot, priorMilestones)` in `src/activation/service.ts` is the single derivation entry point. It composes:

- `deriveStage(snapshot)` -> current stage and reasons.
- `detectMilestones(snapshot, prior)` -> milestone log, idempotent over priors.
- `deriveChecklist(snapshot)` -> five checklist items keyed `brief_captured`, `requirements_defined`, `implementation_started`, `validation_completed`, `release_confirmed`.
- `calculateRisk(snapshot, stage)` -> score 0-100 plus level (`low` < 30, `medium` < 65, `high` >= 65) and a list of reasons.

### Milestone engine

`src/activation/milestones.ts` exports the milestone order and the detection function:

```ts
export const ACTIVATION_MILESTONE_ORDER: ActivationMilestoneKey[] = [
  "intake_ready",
  "scope_defined",
  "build_started",
  "build_complete",
  "validated",
  "released",
  "blocked",
];
```

| Milestone        | Reached when                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `intake_ready`   | `hasBrief` is true.                                              |
| `scope_defined`  | `hasRequirements && hasPlan`.                                    |
| `build_started`  | `hasImplementation` or `startedAt` is set.                       |
| `build_complete` | `hasImplementation` and (`completedAt` or `hasTests`).           |
| `validated`      | `hasValidationEvidence && hasTests && criticalIssueCount === 0`. |
| `released`       | `releasedAt` set or `hasReleaseEvidence`.                        |
| `blocked`        | Stage resolved to `blocked`.                                     |

`mergeMilestoneState` ensures that once a milestone is reached, it stays reached and its `reachedAt` does not move. This makes the milestone log append-only and idempotent.

### Risk

`calculateRisk` adds per-signal weight to a stage-keyed base score, then clamps to `[0, 100]`. Source of truth is `src/activation/risk.ts`.

## Signals

Activation signals come from real workspace activity. The `snapshotForWorkspace(data, workspaceId)` function in `src/packetagent-store.ts` builds the `ActivationSignalSnapshot` from durable product records when present, and falls back to legacy `activationFacts` for workspaces or signal categories without durable records.

### Sources

| Signal                                                                              | Source                                                                                                                  |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `hasBrief`                                                                          | Workflow brief captured on a workspace.                                                                                 |
| `hasRequirements`                                                                   | Requirements records authored against the workspace.                                                                    |
| `hasPlan`, `hasImplementation`                                                      | Implementation plan items and their statuses.                                                                           |
| `hasTests`, `hasValidationEvidence`, `failedValidationCount`                        | Validation evidence records, partitioned by `failedAt`/status.                                                          |
| `hasReleaseEvidence`, `releasedAt`                                                  | Release confirmation records on the workspace.                                                                          |
| `blockerCount`, `dependencyBlockerCount`, `openQuestionCount`, `criticalIssueCount` | Workflow concerns: `kind: "blocker"                                                                                     | "open_question"`, with `dependency` / severity flags. |
| `retryCount`                                                                        | Durable `activationSignals` records with `kind: "retry"` plus `agent.run.retry` activities as a fallback.               |
| `scopeChangeCount`                                                                  | Durable `activationSignals` records with `kind: "scope_change"` plus `workflow.scope_changed` activities as a fallback. |

`buildSignalSnapshotFromProductRecords` in `src/activation/adapters.ts` filters and normalizes those product records into the snapshot. Cancelled/discarded/superseded records are dropped; resolved/closed/answered records do not count toward open blocker or question counts.

### Activation signal records

Durable retry and scope-change signals live in the `activationSignals` collection (JSON store) or the `app_records` collection with metadata indexes (SQLite). The record shape:

```ts
export type ActivationSignalKind = "retry" | "scope_change";
export type ActivationSignalSource =
  | "activity"
  | "agent_run"
  | "workflow"
  | "seed"
  | "user_fact"
  | "system_fact";
export type ActivationSignalOrigin = "user_entered" | "system_observed";

export interface ActivationSignalRecord {
  id: string;
  workspaceId: string;
  kind: ActivationSignalKind;
  source: ActivationSignalSource;
  origin?: ActivationSignalOrigin;
  sourceId?: string;
  stableKey?: string;
  createdAt: string;
  updatedAt: string;
  data?: Record<string, string | number | boolean | null | undefined>;
}
```

`source` is the producer category used for recompute and traceability. `origin` is independently whether the signal came from user-entered behavior or system-observed behavior; a retry can have `source: "agent_run"` while its origin is a signed-in user. `sourceId` is the upstream record id used for dedupe and audit links.

### Idempotency

A repeated write for the same upstream event must not create additional counted activation signals. The runtime enforces this two ways:

- Service paths set `stableKey` (for example, `retry:<runId>`) and SQLite enforces a unique constraint on non-null `stableKey` per workspace; the JSON path dedupes on `stableKey` at upsert time.
- When durable records exist for a kind, runtime snapshots count them first; activity-stream entries (`agent.run.retry`, `workflow.scope_changed`) are only used as a fallback for older streams without durable records.

The test `src/activation-signals.test.ts` covers this round-trip: two retries against the same failed run produce one durable signal and one activity entry.

## Repository Contracts

The pure engine reads facts through three ports declared in `src/activation/contracts.ts`:

```ts
export interface ActivationSignalRepository {
  loadSnapshot(subject: ActivationSubjectRef): Promise<ActivationSignalSnapshot>;
}

export interface ActivationMilestoneRepository {
  listForSubject(subject: ActivationSubjectRef): Promise<ActivationMilestoneRecord[]>;
}

export interface ActivationStatusReadModelRepository {
  save(status: ActivationStatusDto): Promise<void>;
  load(subject: ActivationSubjectRef): Promise<ActivationStatusDto | null>;
}
```

`getActivationStatus(deps, input)` and the higher-level `readActivationStatus(deps, input)` in `src/activation/api.ts` are the only callers. They take the three ports plus a `derive` function (always `deriveActivationStatus` in production) and return an `ActivationStatusDto`.

The repository layer in `src/activation/repositories.ts` ships in-memory implementations used for tests and small callers. `packetagent-services.ts#syncWorkspaceActivation` wires the live ports:

- `signals.loadSnapshot` calls `snapshotForWorkspace(await loadStoreAsync(), workspaceId)`.
- `milestones.listForSubject` reads `data.activationMilestones[workspaceId]`.
- `readModel.save` writes to `data.activationReadModels[workspaceId]` and updates `data.activationMilestones[workspaceId]`. Optionally emits `activation.*` activities when called with `emitActivity = true`.

`activationSignalRepository()` in `src/packetagent-store.ts` selects the JSON or SQLite implementation based on `process.env.PACKETAGENT_STORE`. Both implementations expose `listForWorkspace(workspaceId)` and `upsert(input, timestamp?)`.

The reference SQL schema for the normalized topology lives in `src/db/schema/activation.sql` and defines `activation_tracks`, `activation_milestones`, and `activation_checklist_items` with the same enum values used by the domain.

## API Surfaces

### Public summary

```
GET /api/activation              -> { summaries: PublicActivationEntry[] }
GET /api/activation/:workspaceId -> PublicActivationEntry | 404
```

Each `PublicActivationEntry` (returned by `listPublicActivationSummaries` and `getPublicActivationSummary` in `src/packetagent-services.ts`) is shaped as:

```ts
{
  subject: ActivationSubjectRef; // workspaceId, subjectType: "workspace"
  status: ActivationStatusDto; // stage, risk, milestones, checklist
  summary: ActivationSummaryCardViewModel;
}
```

The public route is wired in `src/server.ts` and reads through `syncWorkspaceActivation(workspaceId, false, { type: "system", id: "public-read" })`. It does not emit activation activities.

### Private detail

```
GET /api/app/activation -> { workspace, onboarding, activation, activities }
```

Wired in `src/app-routes.ts`. Requires authentication and `viewWorkspace` permission. The `activation` field has the same `{ status, summary }` shape as the public endpoint. The same payload appears as `bootstrap.activation` in `GET /api/app/bootstrap`.

### Summary card view model

```ts
export interface ActivationSummaryCardViewModel {
  title: string;
  progressPercent: number;
  progressLabel: string;
  stageLabel: string;
  riskLabel: string;
  riskLevel: ActivationRiskLevel;
  items: ActivationChecklistViewItem[];
  nextRecommendedAction: string | null;
}
```

`buildActivationSummaryCard(status)` in `src/activation/view-model.ts` is the only function that mints this. It produces stable labels (`Brief captured`, `Requirements defined`, etc.) so the workbench does not have to reproduce humanized copy.

## UI

The workbench surfaces activation in two places.

**`/activation` view** (`web/src/workbench/views/activation.tsx`) renders the full checklist. It calls `api.getActivationDetail()` and, for each unchecked checklist item, exposes a "Mark done" button that calls `api.completeOnboardingStep(key)` to advance the matching onboarding step. The view shows progress percent, stage label, the next recommended action, and renders one row per `ActivationChecklistViewItem`.

**Dashboard widget** (`web/src/workbench/views/dashboard.tsx`) reads `bootstrap.activation.summary` and shows progress percent and `nextRecommendedAction`, with an **Open checklist** button that navigates to `/activation`.

Both views share the same view-model shape, so any change to `buildActivationSummaryCard` is observable from both surfaces.

## Onboarding To Activation Mapping

Onboarding step completion is the simplest source of activation facts. `applyOnboardingStepToFacts` in `src/packetagent-services.ts` writes legacy `activationFacts` when a step completes:

| Onboarding step            | Facts written                                        |
| -------------------------- | ---------------------------------------------------- |
| `create_workspace_profile` | `briefCapturedAt`                                    |
| `define_requirements`      | `requirementsDefinedAt`                              |
| `define_plan`              | `planDefinedAt`                                      |
| `start_implementation`     | `implementationStartedAt`, `startedAt`               |
| `validate`                 | `testsPassedAt`, `validationPassedAt`, `completedAt` |
| `confirm_release`          | `releaseConfirmedAt`, `releasedAt`                   |

Workspaces with durable workflow records (briefs, requirements, plan items, validation evidence, release confirmations) bypass this fallback path entirely. Legacy facts only feed the snapshot when no durable record exists for that signal category.

## Extending The Engine

### Add a new milestone

1. Add the key to the `ActivationMilestoneKey` union in `src/activation/domain.ts` and to `ACTIVATION_MILESTONE_ORDER`.
2. Add a case to `detectSingleMilestone` in `src/activation/milestones.ts` that returns `reached(...)` based on the snapshot.
3. Add a coverage test in `src/activation/__tests__/detect-milestones.test.ts` mirroring the existing patterns.
4. Update the SQL `check (key in ...)` constraint in `src/db/schema/activation.sql`.

### Add a new checklist item

1. Add the key to `ActivationChecklistItemKey` and `ACTIVATION_CHECKLIST_ORDER`.
2. Add a case to `deriveSingleChecklistItem` in `src/activation/checklist.ts`.
3. Add label and description copy to the `CHECKLIST_LABELS` map in `src/activation/view-model.ts`.
4. Add coverage in `src/activation/__tests__/derive-checklist.test.ts`.
5. Update the SQL `check (key in ...)` constraint and align `applyOnboardingStepToFacts` if the new item maps to an onboarding step.

### Add a new signal kind

1. Extend `ActivationSignalKind` in `src/packetagent-store.ts` and the matching schema/migration files.
2. Decide if the signal is a count, a boolean, or a timestamp on `ActivationSignalSnapshot`. Add the field to `src/activation/domain.ts`.
3. Plumb the field through `buildSignalSnapshotFromFacts` and `buildSignalSnapshotFromProductRecords` in `src/activation/adapters.ts`.
4. Update `snapshotForWorkspace` in `src/packetagent-store.ts` to feed the new field from durable records, with an activity-stream fallback if appropriate.
5. Reflect the new signal in the producing code path (workflow service, runtime service, etc.) by writing an `activationSignals` record with a `stableKey` so repeated writes are idempotent.
6. Add coverage to `src/activation/__tests__/adapters.test.ts` for the snapshot mapping and to `src/activation-signals.test.ts` for the producing service path.

### Operations

- `npm run jobs:recompute-activation` refreshes activation read models and milestone records for all workspaces, or a targeted set with `--workspace-ids=alpha,beta`.
- `npm run jobs:repair-activation` refreshes stale JSON-backed read models and reports which workspaces changed.
- `npm run db:status` inspects applied and pending SQLite migrations without mutating a missing database.
- Deleting `data/packetagent.json` resets local activation data to the built-in seed state on the next store load.
