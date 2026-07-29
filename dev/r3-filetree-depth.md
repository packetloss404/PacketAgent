# R3 file-tree generation depth

Date: 2026-07-29

`BACKLOG.md` remains the implementation ledger. This record captures the R3
research and decisions that support the closed checklist.

## Decisions

- One canonical `GeneratedFile[]` tree is the source of truth for new and
  converted legacy drafts.
- Validation repair remains bounded to two attempts and stops on a repeated
  diagnostic signature. Repair prompts classify concrete TypeScript/Vite
  failure families and cap diagnostics and included source bytes.
- Plan, write, and validate progress is typed and attempt-aware. A skipped
  sandbox check stays `skipped`; progress callbacks cannot fail generation.
- Iteration review is separate from apply. Review includes every
  added/modified/deleted/unchanged path with before/after SHA-256 and byte-size
  evidence; only changes enter the apply list.
- Page, API-route, data-entity, and selected-component regeneration restores
  model mutations outside the chosen scope before validating the candidate.
- Package installation is a plan, not an effect. It allows only the generated
  React/Vite/TypeScript/Tailwind toolchain and conservative semver specs. Its
  required future execution boundary is Docker, registry-only networking,
  disabled lifecycle scripts, and bounded time/output.
- ZIP export is workspace-authorized and checkpoint-bound. It rejects unsafe
  paths, duplicate/reserved metadata paths, more than 500 files, or more than
  10 MiB of source. It includes git-ready source, a package plan, human
  instructions, and digest provenance.

## ZIP research

Node's stable `node:zlib` API provides Gzip, Deflate/Inflate, Brotli, and Zstd
compression primitives, but it does not provide a multi-file ZIP archive
writer. See the [Node zlib documentation](https://nodejs.org/api/zlib.html).

[`fflate`](https://github.com/101arrowz/fflate) provides ESM-compatible
multi-file ZIP creation and extraction, per-archive compression level and
modification time, and an MIT license. R3 pins `fflate` 0.8.3 and imports only
the ZIP/string functions used by the server and tests. The synchronous builder
is bounded by PacketAgent's 500-file/10-MiB input gate; archive timestamps are
explicit rather than library-default current time.

## Gate evidence

- R3.1 targeted repair strategy: `src/codegen/repair-strategy.ts`
- R3.2 canonical legacy conversion: `canonicalizeIterationFileTree`
- R3.3 progress contract: `CodegenProgressEvent` and Builder `file-progress`
  SSE events
- R3.4 review and targeting: `reviewFileTrees` and
  `scopeGeneratedFileTree`
- R3.5 package/export: `src/codegen/package-plan.ts` and
  `src/codegen/workspace-export.ts`

The final repository-wide gate passed typecheck, zero-warning lint, formatting,
the production web build, 32 web tests, and 1,569 API tests (1,565 passed with
4 intentional live interoperability skips). `BACKLOG.md` remains the canonical
closure record.
