# R6.2 LLM-authored agent templates

Status: complete as of 2026-07-29. R6.3-R6.6 and R7-R8 are also complete; no
automatic loop follows R8.

This record captures the research, trust boundary, implementation, and
verification for the second R6 slice. `BACKLOG.md` remains the sole active
ledger.

## Outcome

The Builder is no longer heuristic-only for agents. It makes one bounded call
through PacketAgent's canonical provider router and asks the selected model to
author the reusable parts of an agent template:

- category, name, summary, description, and instructions;
- a minimal subset of registered tools;
- typed input fields and safe defaults;
- a bounded two-to-eight-step playbook;
- acceptance checks and open questions.

The model does not execute tools, select a new trigger, invent a schedule,
activate background work, resolve credentials, or bypass review. Deterministic
code still owns those decisions.

## Research

The provider policy follows current primary documentation:

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
  describes strict JSON-Schema-constrained model responses.
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
  documents schema-constrained Claude responses.
- [Gemini structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
  supports a documented subset of JSON Schema and explicitly recommends
  application validation for semantic correctness.
- [vLLM structured outputs](https://docs.vllm.ai/en/latest/features/structured_outputs/)
  exposes structured decoding through its OpenAI-compatible server.

The cross-provider conclusion is deliberately narrow: use JSON Schema when the
canonical provider catalog says it is native or conditional, give
best-effort-only providers the same schema in the prompt, and never treat
syntactic schema conformance as authorization or semantic correctness.

## Authoring contract

`src/agent-builder/llm-template.ts` defines the bounded contract:

- operator prompts are 12-2,000 characters;
- authoring is one call, capped at 3,000 output tokens and 30 seconds;
- tools are selected only from the registered runtime catalog;
- input fields, playbook steps, checks, and questions have fixed item and
  string limits;
- the trigger kind and exact cron schedule must equal the deterministic
  builder decision;
- input keys must be unique snake_case and cannot be credential-like;
- enum, number, boolean, and URL defaults are validated locally;
- URL defaults reject embedded username/password credentials;
- unsupported object fields and invalid enums fail the complete model result;
- secret-like assignments are redacted before the draft is returned.

Provider refusal, exception, unavailable routing, non-terminal/tool-use or
truncated output, malformed JSON, schema mismatch, and semantic mismatch do
not partially merge. The
Builder returns its existing deterministic draft and records one of
`provider_unavailable`, `provider_error`, `incomplete_output`, or
`invalid_output`.

## Deterministic merge and UI

`generateAgentBuilderDraftAsync` computes available tools, intent, trigger,
schedule, integration setup, and heuristic defaults before calling the model.
A valid model response may replace reusable prose, inputs, playbook, checks,
and questions. Its registered tools are unioned with deterministic
recommendations; no unregistered tool becomes enabled.

The route forwards request cancellation into the provider deadline. The
workbench labels drafts as either `LLM-authored` with provider/model/category
provenance or `deterministic` with a fallback reason. Approval remains an
explicit, separate request.

## Canonical Worker boundary

Approval still persists the established `AgentRecord` for API compatibility.
The existing W1 projection maps that saved record into a validated
`WorkerVersionContent`, preserves its inputs, playbook, tools, provider
selection, and trigger, and marks the result:

- source kind `legacy_agent`;
- Worker version status `draft`;
- warning `projection.requires_validation`;
- approval-required coarse capabilities for legacy whole-tool grants.

That is intentional. R6.2 proves Worker compatibility; it does not claim the
legacy Agent executor has been replaced. Validation, deployment, activation,
and execution solely through the canonical Worker lifecycle remain the R6.6
gate.

## Verification

Focused tests cover:

- strict structured-output options and schema enums;
- best-effort fenced JSON for a provider without schema mode;
- registered-tool filtering and secret-assignment redaction;
- deterministic trigger/schedule preservation;
- invalid, incomplete, and sensitive-input fallback;
- LLM-to-service merge, Agent approval, route compatibility, and UI
  provenance labels.

`npm run verify:agent-template` uses a deterministic fake provider and makes no
live provider or external tool call. It certifies schema-mode authoring,
registered-tool filtering, redaction, deterministic triggers, unsafe-trigger
rejection, a valid Worker content projection, and the required draft/lifecycle
warning.

The full R6.2 gate requires typecheck, zero-warning lint, repository formatting,
production web build, API tests, web tests, the verifier, and
`git diff --check`.

Gate result: passed. Typecheck, zero-warning lint, repository formatting,
production web build, 34 web tests, 79 focused backend tests, the
seven-assertion verifier, and 1,632 API tests pass (1,629 passed with three
intentional live Packet-product interoperability skips).
