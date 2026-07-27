# PacketAgent dev/

Documentation for people working on PacketAgent - self-hosters running a node, contributors changing the code, and release engineers cutting builds. The top-level [README](../README.md) covers product positioning and a five-line quick start; everything past that lives here.

## What's in here

| Path                                                                   | Audience     | Purpose                                                                                                                      |
| ---------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| [`CODEX-HANDOFF.md`](CODEX-HANDOFF.md)                                 | Contributors | Authoritative state and resume point when opening a new Codex project.                                                       |
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
[`CODEX-HANDOFF.md`](CODEX-HANDOFF.md), and
[`CONTRIBUTING.md`](CONTRIBUTING.md) first. They cover autonomous-worker
invariants, current repository state, naming, startup, tests, and code
conventions. The PacketAgent GitHub repository has not been configured yet.
Until an `origin` exists, use `BACKLOG.md` for coordination and treat GitHub
URLs in historical documents as intended future locations.

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

Use the current Codex handoff, roadmap, and backlog instead.

## Conventions

- All docs are markdown, ASCII-only, no emojis.
- Cross-references use `dev/`-relative paths (e.g. `[Persistence](deployment/persistence.md)`).
- Code fences are tagged (`bash`, `ts`, `json`).
- Headings stop at H2 within a page; H3 only when a single page genuinely needs three levels.
