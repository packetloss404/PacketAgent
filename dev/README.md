# PacketAgent dev/

Documentation for people working on PacketAgent - self-hosters running a node, contributors changing the code, and release engineers cutting builds. The top-level [README](../README.md) covers product positioning and a five-line quick start; everything past that lives here.

## What's in here

| Path                                                                   | Audience     | Purpose                                                                                                                      |
| ---------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| [`../HANDOFF.md`](../HANDOFF.md)                                       | Contributors | Short, exact resume point for a new working session.                                                                         |
| [`CODEX-HANDOFF.md`](CODEX-HANDOFF.md)                                 | Contributors | Detailed implementation inventory and verification history.                                                                  |
| [`roadmap.md`](roadmap.md)                                             | Everyone     | Current state and what's next. No commitments - priority is set by issue activity.                                           |
| [`packetade-packetagent-handoff.md`](packetade-packetagent-handoff.md) | Contributors | Versioned deployment and event contract between PacketADE and PacketAgent.                                                   |
| [`taskloom-to-packetagent.md`](taskloom-to-packetagent.md)             | Operators    | Rename, repository, environment, and data-file compatibility notes.                                                          |
| [`TESTING.md`](TESTING.md)                                             | Release      | Manual end-to-end smoke playbook run before tagging a release.                                                               |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                                   | Contributors | Onboarding: clone, run, test, conventions, PR flow.                                                                          |
| [`deployment/`](deployment/)                                           | Self-hosters | Operator and self-host guides - `README.md`, `persistence.md`, `security.md`, `operations.md`, `email.md`, plus `examples/`. |
| [`architecture/`](architecture/)                                       | Contributors | Design notes - `activation.md` and other subsystem write-ups.                                                                |

## For self-hosters

Start with the [top-level README getting-started section](../README.md#getting-started) to get a node running locally, then move to [`deployment/README.md`](deployment/README.md) for the operator guide. The deployment directory covers data durability, hardening, day-two operations, email delivery, and worked examples for common topologies.

## For contributors

Read [`../AGENTS.md`](../AGENTS.md),
[`../HANDOFF.md`](../HANDOFF.md),
[`CODEX-HANDOFF.md`](CODEX-HANDOFF.md), and
[`CONTRIBUTING.md`](CONTRIBUTING.md) first. They cover autonomous-worker
invariants, current repository state, naming, startup, tests, and code
conventions. Publish PacketAgent work only to
`git@github.com:packetloss404/PacketAgent.git`; the `taskloom-source` remote is
historical and read-only by convention. Use `BACKLOG.md` for implementation
coordination.

## For releases

Before tagging, run the manual smoke playbook in [`TESTING.md`](TESTING.md) against a freshly seeded local node. [`roadmap.md`](roadmap.md) is the public-facing summary of what's landed and what's next; update it when work meaningfully changes the product surface.

## Historical records

The following files preserve earlier TaskLoom/PacketAgent planning and review
work but are not active plans:

- `../docs/HANDOFF.md`
- `../docs/PHASE3_SCOPE.md`
- `../docs/AGENT_PLAYBOOK_FEATURES.md`
- `../docs/AGENT_PLAYBOOK_SPRINTS.md`
- `../REPO_REVIEW.md`
- `../REPO_REVIEW_NOTES.md`

Use the root handoff, detailed Codex handoff, roadmap, and backlog instead.

## Conventions

- All docs are markdown, ASCII-only, no emojis.
- Cross-references use `dev/`-relative paths (e.g. `[Persistence](deployment/persistence.md)`).
- Code fences are tagged (`bash`, `ts`, `json`).
- Headings stop at H2 within a page; H3 only when a single page genuinely needs three levels.
