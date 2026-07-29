# R2 provider policy and key parity

Status: implemented 2026-07-29. `BACKLOG.md` remains the implementation ledger.

## Why this slice exists

PacketAgent previously had six usable provider adapters, but provider names,
models, readiness rules, key support, and generation behavior were repeated
across several modules. Structured responses were prompt-driven, malformed
tool arguments could collapse to an empty object, and Gemini/OpenRouter keys
could not use the workspace vault.

R2 makes those behaviors explicit and testable without claiming that every
model behind every compatible endpoint has identical capabilities.

## Canonical contract

`src/providers/catalog.ts` is the source of truth for:

- provider identity, label, locality, and transport;
- credential, configuration, and model environment variables;
- `fast`, `smart`, `cheap`, and `local` model defaults;
- streaming, tool-use, structured-output, vault, and discovery capabilities;
- hosted multi-file versus local single-file generation policy; and
- exactly one malformed-tool-input correction attempt.

The router registers all adapters independently of process environment keys.
Readiness is resolved per workspace from environment variables, an encrypted
workspace-vault key, or local configuration. The readiness projection returns
only the credential source and public catalog metadata, never key material.

| Provider                | Tool use                                 | Structured response                                     | Generation policy           | Vault key      |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------- | --------------------------- | -------------- |
| Anthropic               | Native                                   | `output_config.format` JSON Schema                      | Hosted, multi-file          | Yes            |
| OpenAI                  | Native                                   | Strict `response_format` JSON Schema                    | Hosted, multi-file          | Yes            |
| Gemini                  | Native through its OpenAI-compatible API | Strict `response_format` JSON Schema                    | Hosted, multi-file          | Yes            |
| OpenRouter              | Model/endpoint conditional               | Strict `response_format`; compatible endpoint required  | Hosted, multi-file          | Yes            |
| MiniMax                 | Native tool calls                        | Best-effort JSON prompt fallback                        | Hosted, multi-file          | Yes            |
| Ollama/local compatible | Server/model conditional                 | vLLM `structured_outputs` when enabled; prompt fallback | Local, one file per turn    | Not applicable |
| Stub                    | Deterministic                            | No native structured response                           | Deterministic test behavior | Not applicable |

OpenRouter requests that use a response schema also set
`provider.require_parameters=true`, so routing fails instead of silently
choosing an endpoint that ignores required parameters.

## Structured-output behavior

Workflow draft and plan generation pass an explicit JSON Schema through the
provider call contract. Adapters map that schema to their native transport
where supported.

For OpenAI-compatible local servers, PacketAgent sends the current vLLM
`structured_outputs: { json: schema }` request field. If that endpoint rejects
the field with HTTP 400, 404, or 422, PacketAgent releases the failed response
and makes exactly one fallback request without constrained decoding. The
fallback prepends a bounded system instruction containing the schema.

`LOCAL_LLM_STRUCTURED_OUTPUTS` controls this behavior:

- `auto` (default) tries the vLLM request field and permits the one fallback;
- `off` skips the constrained field and uses the schema prompt directly.

Native Ollama and other compatible servers remain capability-conditional.
PacketAgent validates/parses their result; it does not claim server-side schema
enforcement where the transport cannot provide it.

## Malformed tool input

Every adapter now uses `src/providers/tool-input.ts`. A malformed JSON string
or a decoded non-object value is marked with a typed input error; the raw
malformed string is not retained as tool input.

The agent loop and Builder draft loop permit one correction turn. The invalid
call is never executed. If the corrected turn is also malformed, the run
returns an explicit error record and stops instead of retrying indefinitely or
executing `{}`.

## Vault and storage parity

Anthropic, OpenAI, OpenRouter, MiniMax, and Gemini share the same encrypted
workspace-key flow. Gemini and OpenRouter were added to:

- the backend and web API-key provider unions;
- the workspace admin key form;
- provider bootstrap and request-time key resolution;
- integration readiness;
- SQLite's fresh schema and migration `0026_provider_kinds.sql`; and
- JSON, SQLite, and managed-Postgres parity tests.

The asynchronous store boundary is used when resolving workspace vault
providers, so managed Postgres is not accidentally read through the synchronous
compatibility path.

## Research basis

The implementation follows the providers' primary documentation as reviewed
on 2026-07-29:

- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Google Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [OpenRouter structured outputs](https://openrouter.ai/docs/guides/features/structured-outputs)
- [vLLM structured outputs](https://docs.vllm.ai/en/v0.15.0/features/structured_outputs/)

Capability metadata is deliberately conservative. OpenRouter and local-server
support remains conditional because the selected downstream model, endpoint,
and server build determine whether tool and schema parameters are honored.

## Verification

Tests cover the catalog contract, adapter request mappings, vLLM fallback,
single correction bound, local single-file authoring, workspace-vault
readiness, secret-free provider status, key masking/resolution, SQLite provider
migration integrity, and storage parity. The exact repository-wide gate result
is recorded in `dev/CODEX-HANDOFF.md` and `CHANGELOG.md`.
