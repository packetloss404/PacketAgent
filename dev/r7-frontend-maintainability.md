# R7 frontend maintainability

Status: R7.1 in progress. `BACKLOG.md` remains the sole implementation ledger.

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
tests pass. Resume R7.1b at the Builder route module's iteration/checkpoint,
publish/export, smoke, and registration seams.

## Out of scope for R7.1

- changing visual direction or doing a CSS rewrite (R7.4);
- replacing the API client or data-fetching strategy (R7.3);
- broad accessibility component changes (R7.2);
- changing Agent or Worker lifecycle semantics;
- renaming historical compatibility fields; and
- splitting large domain services without a separately characterized
  transaction boundary.
