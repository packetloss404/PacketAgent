# R6.3 Agent provider readiness

Status: complete as of 2026-07-29. R6.4-R6.6 and R7-R8 are also complete; no
automatic loop follows R8.

R6.3 made the provider execution contract visible before an authored Agent is
saved or run. It deliberately does not perform a live provider call: the
completed R6.4 gate owns bounded first-run evaluation and separates configured
metadata from observed execution.

## Product contract

The Agent Builder resolves one canonical model-routing preset and uses that
same result for:

- LLM template authoring;
- the readiness view shown to the operator;
- the saved Agent model; and
- the restart-safe provider route used by legacy Agent execution.

The readiness view reports the provider and exact model, whether the provider
is registered, the secret-free key source, model availability, and streaming,
tool-use, and structured-output capability support. Hosted providers require
an environment or workspace-vault key. A local Ollama-compatible provider is
shown as keyless, not as live-verified.

Key sources are metadata only:

- `environment` means the process has the provider-specific variable;
- `workspace_vault` means a provider credential exists for the workspace;
- `local` means the provider is intentionally keyless; and
- `none` blocks the first run.

No secret value, credential reference, or provider response is returned in the
draft readiness payload.

## Model availability

Provider configuration and model availability are separate facts. Before a
probe, a selected model is `configured_unverified`; an unresolved preset is
`missing`. The UI does not claim that a configured model exists at the remote
endpoint.

This distinction follows the providers' current discovery contracts:

- OpenAI exposes models through the
  [Models API](https://platform.openai.com/docs/api-reference/models/object?lang=curl).
- Gemini exposes model metadata through
  [models.list and models.get](https://ai.google.dev/api/models).
- Ollama exposes locally available models through
  [List models](https://docs.ollama.com/api/tags).

Those APIs require external I/O and, for hosted providers, credentials. R6.3
therefore remains deterministic and side-effect free. R6.4 will make a bounded
evaluation call and persist the observed result.

## Capability semantics

Capabilities come from the canonical provider catalog:

- `ready` means the catalog guarantees the capability;
- `conditional` means support depends on the selected model or endpoint;
- `best_effort` means PacketAgent accepts bounded JSON text and still performs
  local semantic validation;
- `missing` means a required capability or runtime cannot be resolved; and
- `not_required` means the authored Agent does not need the capability.

Conditional tool use remains visible and must be verified during the R6.4
first-run evaluation. Structured output never bypasses PacketAgent's local
schema and semantic checks.

## Restart-safe execution

Saved Agents use stable route keys:

| Provider     | Route key                   |
| ------------ | --------------------------- |
| Anthropic    | `agent.provider.anthropic`  |
| OpenAI       | `agent.provider.openai`     |
| OpenRouter   | `agent.provider.openrouter` |
| MiniMax      | `agent.provider.minimax`    |
| Ollama/local | `agent.provider.ollama`     |
| Gemini       | `agent.provider.gemini`     |

The saved Agent also retains the exact resolved model, which overrides the
route default during execution. This prevents an Agent authored with one
preset/provider from silently running through a different default after a
process restart.

Legacy workspace `ProviderRecord` bindings remain compatible. When a generated
Agent has no legacy provider record, execution rechecks the actual environment
or workspace-vault credential before contacting a hosted provider.

## Verification

Run:

```bash
npm run verify:agent-readiness
```

The deterministic verifier proves exact preset resolution, secret-free key
source reporting, conditional capability visibility, unverified model
truthfulness, keyless-local semantics, fail-closed unresolved runtimes, and
restart-safe provider routes. Unit, API-route, service-reload, and web utility
tests cover the same boundary without a live provider.

R6.3 closed after the repository quality gate and full API/web suites passed.
R6.4 later shipped editable memory/input examples and a bounded, persisted
first-run evaluation; R6.5-R6.6 and R7-R8 are also complete.
