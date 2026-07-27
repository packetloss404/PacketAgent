# Agent/playbook sprint plan

> **Status: completed historical sprint plan.** The described vertical slice
> is present in the inherited codebase. Do not restart these sprints. Continue
> from [`../dev/CODEX-HANDOFF.md`](../dev/CODEX-HANDOFF.md) and the active W1-W10
> loops in [`../BACKLOG.md`](../BACKLOG.md).

This plan is scoped to a shippable vertical slice: prompt-to-agent builder parity, ordered playbooks, tool approval, first-run readiness, and a trace inspector based on existing run data.

## Sprint 1: Stabilize the contract

Goal: make the run-detail and trace surface explicit without requiring a new storage layer.

Work:

- Add a first-class trace span DTO.
- Derive trace spans from `AgentRunRecord` transcript, tool calls, logs, inputs, output, model, cost, and status.
- Add a run detail API that returns one run plus derived trace.
- Keep workspace scoping and RBAC checks on the server.
- Add backend tests for success, failed setup, canceled approval, and tool-call traces.

Primary files:

- `src/packetagent-services.ts`
- `src/app-routes.ts`
- `src/server.ts`
- `web/src/lib/types.ts`
- `web/src/lib/api.ts`

## Sprint 2: Agent builder parity

Goal: `/builder` can intentionally build an app or an agent, and agent mode does not leak into app generation.

Work:

- Tighten builder mode selection.
- Route agent prompts into `AgentBuilderPanel`.
- Preserve saved-agent handoff.
- Keep app generation unchanged in app mode.
- Add web tests for mode routing and copy expectations.

Primary files:

- `web/src/workbench/views/builder.tsx`
- `web/src/workbench/views/builder-agent.tsx`
- `web/src/workbench/views/builder-agent-utils.tsx`
- `web/src/workbench/views/builder-copy.test.tsx`

## Sprint 3: Playbook authoring polish

Goal: make ordered playbooks feel like reusable operational playbooks, not a raw textarea list.

Work:

- Improve step validation and empty states.
- Make reorder/remove affordances stable and accessible.
- Show run-to-playbook review detail before replacing an agent playbook.
- Keep role gating clear.
- Add tests for normalization and record-as-playbook behavior.

Primary files:

- `web/src/workbench/views/agent-editor.tsx`
- `src/packetagent-services.ts`
- `src/packetagent-services.test.ts`

## Sprint 4: Trace inspector UI

Goal: a single run page explains what happened.

Work:

- Fetch a single run detail instead of loading all runs and searching client-side.
- Render trace summary, timeline, transcript, tool calls, logs, inputs, output, artifacts, model, and cost.
- Preserve retry/cancel/diagnose actions.
- Handle empty trace and legacy run states.
- Add frontend helper tests where possible.

Primary files:

- `web/src/workbench/views/run-deep.tsx`
- `web/src/workbench/views/agent-editor.tsx`
- `web/src/lib/api.ts`
- `web/src/lib/types.ts`

## Sprint 5: Runtime event quality

Goal: make real and dry runs produce useful trace material.

Work:

- Include approval/cancel/setup-required events in derived traces.
- Include provider/model/cost logs in the run detail surface.
- Keep tool-call inputs and outputs bounded and redacted where needed.
- Add tests for approval launch, cancel, missing provider, and missing tool cases.

Primary files:

- `src/packetagent-services.ts`
- `src/tools/agent-loop.ts`
- `src/tools/approval.ts`
- `src/packetagent-services.test.ts`

## Sprint 6: Docs and release readiness

Goal: make the feature understandable for the next maintainer and safe to ship.

Work:

- Update handoff/backlog status.
- Document current limitations and future graph/trace-span migration.
- Run focused tests, then full typecheck/test/build.
- Peer review for security, RBAC, trace correctness, and UI regressions.

Primary files:

- `docs/HANDOFF.md`
- `BACKLOG.md`
- `docs/AGENT_PLAYBOOK_FEATURES.md`
- `docs/AGENT_PLAYBOOK_SPRINTS.md`

## Six-worker implementation split

1. Backend trace contract and run detail API.
2. Runtime trace derivation and approval/setup event tests.
3. Agent builder backend/readiness tests.
4. Builder shell agent-mode routing.
5. Playbook editor and run-to-playbook UX.
6. Run trace inspector UI.

## Peer review focus

- Workspace and role boundaries.
- Secret and credential redaction.
- Agent/app mode separation.
- Stable trace ordering.
- Approval token replay behavior.
- Legacy run rendering.
- Small-screen UI fit.
- No accidental live third-party calls in tests.
