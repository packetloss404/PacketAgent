# PacketAgent contributor instructions

## Product identity

PacketAgent is the self-hosted autonomous-worker runtime in the Packet suite.

- PacketADE plans, builds, and supervises development work.
- PacketCode is the terminal coding environment.
- PacketChat is the conversational surface.
- PacketPhone is the mobile and remote approval surface.
- PacketAgent runs durable workers after the originating application closes.

"Always on" refers to the control plane. Workers are event-driven and bounded, not endless token loops.

## Product invariants

Every autonomous Worker must be:

- bounded by time, cost, iterations, failures, and permissions;
- permissioned at the runtime tool boundary;
- resumable from a durable checkpoint;
- safe against duplicate external effects;
- auditable through events, evidence, and provenance; and
- stoppable and revocable independently of its authoring client.

Do not claim the unified Worker lifecycle is shipped until its backlog gate passes.

## Naming

Use `PacketAgent`, `packetagent`, and `PACKETAGENT_*` for all new code.

The old TaskLoom name is allowed only in migration compatibility, migration tests, historical documentation, and Git history. Do not add new public APIs or persisted identifiers with the old name.

Runtime branding and legacy migration constants live in `src/brand.ts`. Web branding lives in `web/src/config/brand.ts`.

## Planning sources

- `dev/CODEX-HANDOFF.md` - start here when opening this repository in a new Codex project.
- `README.md` - public product truth and setup.
- `dev/roadmap.md` - short direction.
- `BACKLOG.md` - master implementation ledger and loop gates.
- `dev/packetade-packetagent-handoff.md` - PacketADE deployment contract.
- `dev/taskloom-to-packetagent.md` - rename and compatibility notes.
- `CHANGELOG.md` - shipped history only.

Do not use historical planning documents as active task ledgers.

For a new Codex project, read these in order:

1. `AGENTS.md`
2. `dev/CODEX-HANDOFF.md`
3. `dev/roadmap.md`
4. the active loop in `BACKLOG.md`

`docs/HANDOFF.md`, `docs/PHASE3_SCOPE.md`, `REPO_REVIEW.md`, and
`REPO_REVIEW_NOTES.md` are historical records. They are not current task
instructions.

## Technical shape

- Node.js 22+, TypeScript, Hono REST/SSE API.
- React 19 and Vite web workbench.
- Provider router and bounded tool-using agent runtime.
- JSON, SQLite, and managed Postgres storage modes.
- Persistent scheduler, webhooks, alerts, retries, and dead-letter handling.
- Encrypted vault, RBAC, approval tokens, audit, sandbox, and browser runtime.

## Commands

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run build:web
npm run test:api
npm run test:web
```

Keep tests deterministic. Add backend parity coverage when changing persisted records. Never place raw secret values in Worker packages, logs, events, or evidence.
