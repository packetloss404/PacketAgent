# TaskLoom to PacketAgent migration

PacketAgent was created from the full TaskLoom Git history on 2026-07-27. The original checkout was preserved as a recovery copy.

## Repository state

- New working directory: `D:\projects\PacketAgent`
- Foundation branch: `codex/packetagent-foundation`
- Historical source remote: `taskloom-source`
- Future PacketAgent remote: not configured yet

All committed local TaskLoom branches and worktrees were already ancestors of TaskLoom `main`. One uncommitted Builder viewport/grid fix was reviewed and carried into the PacketAgent foundation branch.

The historical source remote is deliberately not named `origin`, which prevents an accidental PacketAgent push to the TaskLoom repository.

When opening the renamed repository as a new Codex project, continue from
[`CODEX-HANDOFF.md`](CODEX-HANDOFF.md). Do not reconstruct state from the
original TaskLoom checkout or archived handoff documents.

## Runtime compatibility

New names are canonical:

- package and repository: `packetagent`
- environment prefix: `PACKETAGENT_`
- default JSON store: `data/packetagent.json`
- default SQLite store: `data/packetagent.sqlite`

Temporary read compatibility:

- A `TASKLOOM_*` value populates the matching missing `PACKETAGENT_*` variable.
- If only a legacy default data file exists, first boot copies it to the new default path.
- Canonical PacketAgent values and files always win.
- Legacy data files are preserved rather than moved or deleted.

Compatibility code lives in `src/brand.ts` and has focused tests in `src/brand.test.ts`.

## Cleanup policy

New APIs, types, files, UI copy, and configuration must use PacketAgent names. The old name is allowed only in migration code, migration tests, historical documentation, and Git history.

Remove the compatibility layer only after an explicit migration release and a documented deprecation window.
