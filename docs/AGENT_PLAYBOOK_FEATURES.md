# Agent/playbook builder and run trace inspector

> **Status: implemented historical feature brief.** The agent builder,
> playbooks, launch approval flow, and derived run trace are present in the
> inherited codebase. The canonical Worker lifecycle later shipped through
> W1-W10; [`../BACKLOG.md`](../BACKLOG.md) retains the closure evidence and
> decision-gated work. This file is design context, not an active plan.

This feature turns PacketAgent's agent path from a configuration form into a task-native agent studio: describe an agent, review the generated plan, save a reusable playbook, run it with typed inputs, approve risky tools, and inspect what happened afterward.

## Product direction

PacketAgent should borrow the useful parts of Dify, Langflow, Flowise, and Dust without becoming a generic node-canvas platform:

- Dust: named agents as project coworkers, reusable skills/playbooks, setup-aware tools, and durable execution records.
- Flowise: clear separation between reasoning agent steps and deterministic tool/action steps.
- Dify: workflow vs conversational workflow mental model, publishable artifacts, and practical run observability.
- Langflow: a fast test loop with inspectable steps, typed inputs, and per-step output.

The PacketAgent-specific wedge is the task lifecycle. Agents should reason about ownership, blockers, approvals, status updates, handoffs, schedules, and run records before they expose raw automation primitives.

## User-facing scope

### Prompt-to-agent builder

Users can describe an agent and receive a draft with:

- name, description, and instructions
- provider/model selection and readiness
- trigger type and schedule/webhook guidance
- enabled tools and missing setup
- typed input schema and sample inputs
- ordered playbook steps
- acceptance checks and open questions
- optional first preview run

The builder must keep app and agent modes separate. An agent prompt should never start the app generation stream.

### Playbook builder

The current sprint keeps playbooks as ordered steps. Each step should be easy to add, reorder, edit, validate, and capture from a prior run. The model should stay compatible with a future graph shape:

- agent reasoning
- deterministic tool/action
- human approval
- condition
- transform
- output
- sub-agent/run-agent

The graph model is a later migration; this sprint should avoid painting the flat-step model into a corner.

### Tool approval and setup

Tool-enabled runs require a clear approval moment before execution. The user should see:

- which tools will run
- read/write/exec side
- risk level and plain-language risk summary
- token expiry
- Launch, Edit tools, and Cancel actions

Current approval is whole-tool scoped. Future work should move toward resource-scoped approvals such as `http.fetch:GET:api.github.com` or `github.pr.comment:repo/name`.

### First run and readiness

The builder approval flow should support a first run when setup allows it. If setup is missing, the saved agent should still be useful: the UI should show blockers and give the user a clean path to finish configuration.

### Run trace inspector

The run inspector should show a trace-like timeline synthesized from the current run data:

- run status, trigger, duration, model, cost, inputs, and output
- playbook transcript
- tool calls with input/output/error/artifacts
- logs
- approval/cancel/setup-required events
- retry, cancel, diagnose, and record-as-playbook actions where available

This sprint can derive trace spans from existing run fields. A dedicated trace-span store can come later after the UI and contract settle.

## Acceptance criteria

- A user can enter "watch GitHub PRs and post a Slack digest", generate an agent draft, see GitHub/Slack tool setup, edit the playbook, provide sample input, approve risky tools, save the agent, run it, and inspect the resulting run.
- App builder mode and agent builder mode remain separate in `/builder`.
- Tool-enabled agent runs ask for approval before execution and record launch, cancel, setup-required, success, and failure states.
- The run inspector highlights failed runs and failed tool calls without hiding raw-but-redacted debugging detail.
- Legacy runs without rich trace data still render from transcript, tool calls, logs, inputs, and output.
- Tests cover backend agent draft generation, run approval behavior, run detail/trace derivation, app-vs-agent builder routing, and trace inspector rendering helpers.

## Deliberate non-goals

- No generic node canvas in this sprint.
- No marketplace dependency.
- No arbitrary user-authored Python or JavaScript extension path.
- No unbounded agent data access.
- No invisible write actions.
- No model catalog as the primary UI.

## Source references

- Dify workflow/chatflow and logs: https://docs.dify.ai/en/use-dify/build/workflow-chatflow and https://docs.dify.ai/en/use-dify/monitor/logs
- Langflow flows/components/traces: https://docs.langflow.org/concepts-flows and https://docs.langflow.org/traces
- Flowise Agentflow V2/evaluations: https://docs.flowiseai.com/using-flowise/agentflowv2 and https://docs.flowiseai.com/using-flowise/evaluations
- Dust agents/tools/skills: https://docs.dust.tt/docs/quickstart-agent, https://docs.dust.tt/docs/tools, and https://docs.dust.tt/docs/skills
