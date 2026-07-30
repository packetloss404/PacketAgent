# R6.4 Agent memory, examples, and first-run evaluation

R6.4 turns the Agent Builder's first run from a local synthetic preview into a
bounded real Agent execution with durable, inspectable evaluation evidence.
It also gives operators editable non-secret memory, saved input examples, and
an expected-output review contract before launch.

This loop does not claim that legacy Agents use the canonical Worker lifecycle.
That compatibility and migration gate remains R6.6.

## Product contract

An authored Agent may now persist:

- up to 12 memory entries, each with an ID, label, and bounded content;
- a typed `exampleValue` on each input-schema field;
- an evaluation specification containing expected-output review context and
  the enabled tools that must complete; and
- one versioned `packetagent.agent-first-run-evaluation/v1` evidence record on
  the resulting Agent run.

Memory and examples are ordinary authored configuration, never credential
storage. The service rejects secret-bearing memory, secret-key examples, and
secret-like evaluation expectations. Raw provider keys still belong in the
workspace vault or supported environment configuration.

The Builder and Agent editor expose the same fields. Builder sample inputs are
saved back to `inputSchema[].exampleValue` during approval, even when readiness
blocks the run or tool approval is still pending.

## First-run execution

The first evaluation uses the existing bounded legacy Agent loop:

1. Load and validate the saved input examples.
2. Revalidate provider, exact model, credential metadata, and runtime tools.
3. If any enabled registered tool can run, return the existing explicit launch
   approval request without creating a run.
4. On approval, or immediately for a tool-free Agent, call the selected model
   through the bounded Agent loop.
5. Persist the run, output, model, logs, and tool-call evidence.
6. Build and attach deterministic evaluation evidence to that same run.

Memory is injected as clearly labeled operator-authored context in the user
prompt for real model-backed Agent-loop runs. It does not change the system
authority or grant a tool permission.
Tool-capable evaluations use the existing signed, expiring, exact-tool launch
approval; R6.4 adds no approval bypass.

The older `/agent-prompt` compatibility route retains its explicitly labeled
local preview. The primary Builder approval path is the real first-run
evaluation path.

## Deterministic evaluation

PacketAgent records four structural checks:

| Check                  | Pass condition                                           |
| ---------------------- | -------------------------------------------------------- |
| Expected input example | Actual typed run inputs exactly match the saved examples |
| Run completed          | The bounded Agent run has `success` status               |
| Actual output captured | A non-empty redacted output was persisted                |
| Required tool calls    | Every required tool has at least one successful call     |

The overall evaluation passes only when every check passes. Failed setup,
cancellation, input drift, empty output, missing tools, errors, and timeouts
therefore fail closed.

The expected-output text is operator-review context. PacketAgent deliberately
does not make a second model call to invent a semantic score. Operators see the
expected text beside the actual output and can judge meaning directly. This
keeps the first-run cost and authority bounded while preserving honest
evidence.

## Durable evidence and storage

The evaluation includes:

- saved expected inputs, expected-output context, and required tools;
- redacted actual inputs and output;
- actual tool names and statuses;
- the run status and selected model;
- per-check pass/fail notes; and
- the evaluation timestamp.

JSON and managed Postgres preserve the nested record through the document
store. SQLite migration `0029_agent_run_evaluation.sql` adds a JSON-validated
`evaluation` column to `agent_runs`; repository dual write, read, backfill, and
verification canonicalization include the new field.

The Agent run trace derives a separate `evaluation` span containing the same
bounded evidence. The Builder result and expanded Agent-run view show checks,
expected versus actual output, and notes.

## Research decisions

The implementation follows the current evaluation guidance without expanding
the runtime's authority:

- OpenAI's agent guidance recommends establishing a performance baseline and
  using real tool calls and instructions in evaluation rather than relying on
  a synthetic transcript:
  <https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/>
- OpenAI's grader and Evals APIs establish that model-based grading is a
  separate evaluation operation, not something to imply without actually
  executing a grader:
  <https://platform.openai.com/docs/api-reference/graders?api-mode=chat> and
  <https://platform.openai.com/docs/api-reference/evals>
- Anthropic's evaluation guidance recommends specific, measurable success
  criteria. R6.4 therefore records exact input, run, output, and tool
  conditions:
  <https://docs.anthropic.com/en/docs/test-and-evaluate/define-success>

From those sources, R6.4 makes three explicit choices:

1. Run the real bounded Agent path; do not label a fabricated local transcript
   as evaluation.
2. Record deterministic structural facts locally; do not add an unrequested
   second LLM judge call.
3. Keep expected semantic output visible for human review instead of
   presenting a false automatic quality score.

## Verification

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run build:web
npm run test:web
npm run verify:agent-first-run
npm run test:api
```

`verify:agent-first-run` performs no network calls. Its seven assertions prove
the versioned evidence schema, saved-input comparison, actual-output capture,
required-tool evidence, deterministic pass behavior, fail-closed behavior,
semantic-review note, and secret redaction.

The R6.4 checkpoint passes:

- 37 web tests;
- 81 focused backend tests;
- all seven standalone verifier assertions; and
- 1,642 API tests: 1,639 passed and three intentional live interoperability
  probes skipped.

The next loop is R6.5: signed, versioned Agent/Worker import and export.
