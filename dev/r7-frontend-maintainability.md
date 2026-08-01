# R7 frontend maintainability

Status: R7.1 complete. R7.2 is active; `BACKLOG.md` remains the sole
implementation ledger.

## Goal

Reduce the remaining oversized workbench views and route modules along the
feature seams that already exist in the repository. R7 is a behavior-preserving
maintainability loop, not a frontend rewrite.

The decomposition rules are:

- keep one source of truth for coordinated state in the closest common
  controller;
- pass explicit values and event handlers to controlled feature components;
- keep network synchronization in controller hooks and user actions in event
  handlers;
- extract pure formatting, validation, and projection helpers separately from
  React state;
- register routes from feature-owned modules rather than sharing mutable route
  state; and
- add characterization coverage before removing or deduplicating behavior.

These rules follow React's guidance on
[sharing state between components](https://react.dev/learn/sharing-state-between-components),
[avoiding unnecessary effects](https://react.dev/learn/you-might-not-need-an-effect),
and
[reusing stateful logic through custom hooks](https://react.dev/learn/reusing-logic-with-custom-hooks).

## R7.1 audit

The 2026-07-29 line-count audit found five production modules above 1,000
lines:

| Module                                      | Lines | Existing seam                                             |
| ------------------------------------------- | ----: | --------------------------------------------------------- |
| `src/app-routes/builder-core.ts`            | 4,381 | iteration, checkpoint, publish, export, and smoke routes  |
| `web/src/workbench/views/agent-editor.tsx`  | 2,443 | form, run control, run history, playbook, tools, contract |
| `web/src/workbench/views/builder.tsx`       | 1,480 | controller, thread, preview, tabs, publish                |
| `web/src/workbench/views/builder-agent.tsx` | 1,397 | controller, readiness, review, first evaluation           |
| `web/src/workbench/views/settings.tsx`      | 1,041 | settings sections and workspace actions                   |

Large domain services such as `src/services/agents.ts` are not silently pulled
into R7.1: the backlog names views and route modules, and service decomposition
needs its own behavior and transaction-boundary audit.

## Executable R7.1 subloops

1. **Agent editor.** Keep loading, mutation, and coordinated run state in one
   controller. Extract controlled form, tool/playbook/contract editors, launch
   approval, run-history, transcript, evaluation, and tool-call presentation
   modules. Characterize payload conversion and the rendered run states.
2. **Builder route module.** Split iteration/checkpoint, publish/export, smoke,
   and registration modules. Keep store mutations and route-specific
   authorization in the owning module; share only typed pure helpers.
3. **App Builder view.** Retain one controller for the current draft and stream.
   Move feature state and actions into focused hooks, then render the existing
   thread/preview/tab components through explicit contracts.
4. **Agent Builder view.** Extract provider readiness, review, save/evaluate,
   and first-run result surfaces while keeping the authored draft as the single
   parent-owned state.
5. **Settings view.** Extract the existing settings sections and destructive
   workspace actions with explicit permission props.
6. Re-run the line-count audit. No production view or route module identified
   above may remain over 1,000 lines without a documented ownership reason.

Each subloop runs typecheck, zero-warning lint, formatting, production web
build, relevant characterization tests, and the full web suite. Backend route
subloops also run the focused route/API tests. R7.1 closes only after the
repository gates pass and `BACKLOG.md` records the resulting module ownership.

## Progress

R7.1a completed the Agent editor split:

- typed launch input conversion, playbook validation, approval classification,
  and bounded evidence serialization now live in
  `web/src/workbench/views/agent-editor/helpers.ts`;
- transcript, first-run evaluation, and tool-call presentation now live in
  `web/src/workbench/views/agent-editor/run-presenters.tsx`;
- nine characterization tests cover typed examples/payloads, missing playbook
  titles, legacy run/approval response classification, approval risk, empty and
  populated controlled/editor/transcript states, run history, evaluation/tool
  evidence, and bounded serialization;
- the prior `RunTranscript` and `ToolCallTimeline` imports remain compatible;
  and
- the original view fell from 2,443 to 548 lines. Loading, mutations,
  coordinated state, and API actions moved intact into a 537-line controller
  hook; every controlled/presentation module is below 400 lines.

Typecheck, zero-warning lint, formatting, production web build, and all 48 web
tests pass.

R7.1b completed the Builder route split:

- `src/app-routes/builder-core.ts` fell from 4,381 lines to an 11-line
  compatibility facade;
- eleven modules now own contracts, draft/apply, generated-app lookup/export,
  iteration, pure iteration transforms, checkpoints, publish handlers,
  publish artifacts, Agent publishing, smoke validation, and registration;
- the modules range from 193 to 722 lines, with no route module above the
  1,000-line audit threshold; and
- a deterministic characterization test pins all 35 established Builder route
  method/path pairs, while the 46-test focused API selection covers iteration,
  checkpoints, source/export, preview/smoke, publish/integrity, rollback,
  authorization, and workspace isolation.

Typecheck, zero-warning lint, formatting, production web build, all 48 web
tests, the focused route selection, and the full 1,661-test API suite pass.

R7.1c completed the App Builder view split:

- `web/src/workbench/views/builder.tsx` fell from 1,480 to 879 lines and remains
  the controlled composition over the existing thread, preview, source,
  quality, activity, sandbox, checkpoint, and publish feature modules;
- current draft/stream state, generation and iteration orchestration,
  checkpoint/publish refresh, retry handling, approval, rollback, branching,
  publishing, and coordinated selections moved intact into the 684-line
  `web/src/workbench/views/builder/use-builder-controller.ts` hook; and
- a server-rendered cold-start characterization locks the controlled composer,
  starter chips, tour affordance, and pre-draft absence of preview and approval
  surfaces.

Typecheck, zero-warning lint, formatting, production web build, and all 49 web
tests pass.

R7.1d completed the Agent Builder view split:

- `web/src/workbench/views/builder-agent.tsx` fell from 1,397 to 254 lines and
  remains the single parent-owned draft composition;
- generation, auto-generation, authored draft/sample state, memory and
  expected-output editing, approval/save, and approval-bound first-run launch
  moved intact into the 215-line
  `web/src/workbench/views/builder-agent/use-agent-builder-controller.ts` hook;
- draft summary/readiness/plan, configuration/sample inputs, and
  approval/first-run results live in controlled modules ranging from 289 to
  381 lines; and
- two rendering characterizations cover authoring/provider/capability truth,
  plan review, memory and expected-output editing, sample validation, approval
  copy, and the empty first-run state.

Typecheck, zero-warning lint, formatting, production web build, and all 51 web
tests pass.

R7.1e completed the Settings view split:

- `web/src/workbench/views/settings.tsx` fell from 1,041 to 105 lines and owns
  only tab selection plus section data contracts;
- member/invitation/share access, API-key/workspace credentials, audit/advanced
  presentation, and typed advanced-entry data moved intact into modules ranging
  from 108 to 340 lines; and
- two rendering characterizations preserve viewer permission boundaries and
  controlled empty states across members, invitations, shares, API keys,
  audit, and advanced operations.

The final R7.1 audit is closed:

| Original module                             | Original | Bounded result                                  |
| ------------------------------------------- | -------: | ----------------------------------------------- |
| `src/app-routes/builder-core.ts`            |    4,381 | 11-line facade; feature modules at or below 722 |
| `web/src/workbench/views/agent-editor.tsx`  |    2,443 | 548-line view; 537-line controller              |
| `web/src/workbench/views/builder.tsx`       |    1,480 | 879-line view; 684-line controller              |
| `web/src/workbench/views/builder-agent.tsx` |    1,397 | 254-line view; feature modules at or below 381  |
| `web/src/workbench/views/settings.tsx`      |    1,041 | 105-line view; feature modules at or below 340  |

Typecheck, zero-warning lint, formatting, production web build, and all 53 web
tests pass. Resume R7.2 by inventorying shared accessible loading/error/empty
boundaries and keyboard-unsafe interactions in critical Builder and Worker
surfaces.

## Out of scope for R7.1

- changing visual direction or doing a CSS rewrite (R7.4);
- replacing the API client or data-fetching strategy (R7.3);
- broad accessibility component changes (R7.2);
- changing Agent or Worker lifecycle semantics;
- renaming historical compatibility fields; and
- splitting large domain services without a separately characterized
  transaction boundary.
