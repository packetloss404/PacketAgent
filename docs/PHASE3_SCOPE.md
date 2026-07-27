# Phase 3 Scope v2 - Make PacketAgent Actually Be The Thing

> **Status: archived historical plan.** This document describes the former
> TaskLoom app/agent-builder direction. Much of its implementation inventory is
> now present, some estimates and model claims are stale, and its priority order
> has been superseded by PacketAgent's autonomous-worker roadmap. Do not resume
> work from this file. Start with [`../dev/CODEX-HANDOFF.md`](../dev/CODEX-HANDOFF.md),
> [`../dev/roadmap.md`](../dev/roadmap.md), and [`../BACKLOG.md`](../BACKLOG.md).

This is the second pass at scoping the work needed to deliver the owner's
verbatim goal:

> I just wanted to be able to create agents and apps like those sites
> [twin.so / lovable / replit] but from my own 1.5TB RAM farm.

The v1 draft was reviewed by six independent agents (technical feasibility,
local LLM realism, sandbox + security, existing-code audit, scope honesty,
goal alignment) and the consensus was: **NEEDS-REVISION**. This is v2,
which incorporates their findings.

## TL;DR

Phase 3 is **29-39 focused days, 6-9 calendar weeks** for a solo engineer
at realistic ~60% focused time. The v1 number (14-20 days / 3 weeks) was
happy-path-only.

The five tracks below stay, plus a **new cross-cutting Security track**.
The total grew because the day estimates are honest now AND a few security
items are non-negotiable; it stayed under control because the existing-code
audit found we already have ~30-40% of what v1 proposed to build:
sandbox, scheduler, webhook intake, tool registry, OpenAI + Ollama
providers, agent templates + runs + repo pattern.

Three architectural decisions drive the plan:

1. **File-tree is the source of truth** for generated apps. The structured
   draft (`pageMap`, `apiRouteStubs`, `dataSchema`) becomes a derived view.
   v1 left both alive; that's perpetual drift.
2. **Local LLM uses grammar-constrained decoding** (XGrammar in vLLM).
   This is the single biggest reliability lever for local tool-use. Without
   it, local feels broken regardless of model quality.
3. **`node:vm` is not a security boundary.** Drop it entirely. Default
   sandbox is Deno subprocess with `--allow-fs-read/write=<workspace>` +
   `--allow-net=<allowlist>`. Works on Windows where bwrap/firejail/gvisor
   don't.

## What the reviewers caught that v1 missed

### Reviewer A (technical feasibility)

- v1 budget under by 2-3x. Realistic: 29-44 focused days.
- File-tree vs structured-draft dualism. Pick one.
- Track B's tsc-repair loop is the hardest piece, under-budgeted 3x.
- The dep graph `A -> (E parallel) -> B -> C -> D` is sequential, not
  parallelizable.

### Reviewer B (local LLM realism)

- Model list is stale. **Qwen3-Coder-Next (80B MoE, 3B active)** is the
  sweet spot - 70.6% SWE-bench Verified. **Qwen3-Coder-480B** is the top
  tier. Drop Llama 3.3 70B and DeepSeek-Coder-v3 from the list.
- **XGrammar** (grammar-constrained decoding in vLLM / SGLang) closes most
  of the local tool-use reliability gap. Defect rate drops from 30-45% to
  10-18% (Claude league).
- Local should default to **smaller per-turn output, more turns**; hosted
  to **larger per-turn, fewer turns**. The router needs per-provider
  policy, not just per-provider adapter.
- OpenRouter free tier: 50 req/day. Builder burns this in one app
  generation. Free models often return "No endpoints support tool use"
  even when nominally they do.
- Gemini OpenAI-compatible endpoint shaves a day, but streaming format
  still differs and thinking tokens leak into the visible stream if
  naively concatenated.

### Reviewer C (security)

- `node:vm` is documented as not-a-security-boundary. One-line escape.
  **Drop entirely.** Default to Deno subprocess with permission flags.
- Path traversal needs more than "constrain to workspace dir": realpath +
  symlink defense + Windows-specific (NTFS ADS, reserved device names,
  case collision, UNC, trailing dots).
- API keys leak via `process.env` inheritance - v1 was silent. Per-app
  runtimes and sandbox builds must spawn with scrubbed env.
- Network egress: deny-by-default + per-app declared allowlist +
  hard-coded SSRF blocklist (`169.254.169.254` cloud metadata, RFC1918,
  loopback). Without this, every "fetch a weather API" app is one
  prompt-injection from metadata theft.
- Preview served same-origin = CSRF-into-self via LLM-authored `fetch`
  calls. Need separate origin or strict CSP.
- Agent capability model must be typed per-resource
  (`http.fetch:GET:api.github.com`), not per-tool global.

### Reviewer D (existing-code audit)

- **Already exists, v1 was duplicating:**
  - `src/sandbox/{docker-driver, native-driver, sandbox-service, sandbox-store}.ts`
  - `src/jobs/cron.ts` + `src/jobs/scheduler.ts` (full cron parsing +
    leader-lock)
  - `src/webhook-routes.ts` (`POST /agents/:token` + token rotation +
    `agent.run` job enqueue)
  - `src/tools/registry.ts` (15+ shipped tools: read / write / shell
    sandboxed / browser-control)
  - `src/providers/{anthropic, openai, ollama, minimax}.ts`
  - `agent-templates.ts`, `agent-runs.ts`, `agent-runs-read.ts` (6
    templates + repo pattern + read parity tests)
- **Actually missing, v1 assumed it exists:**
  - Gemini provider
  - OpenRouter provider
  - Per-app server runtime (`generated-app-runtime.ts` is metadata-only)
- **Shipped tools NOT useful for typical agent demos**: existing tools
  are workspace-introspection (read brief, list reqs, list blockers,
  http_get). Missing for "agent that watches GitHub and posts to Slack":
  Slack, GitHub API, email send, generic SQL.

### Reviewer E (day estimates)

- Track A: 2-3d claim -> 5-8d real.
- Track B: 4-6d claim -> 10-16d real. Most under-estimated.
- Track C: 3-4d claim -> 6-9d real. `better-sqlite3` on Windows is
  native-module hell.
- Track D: 3-4d claim -> 8-14d real. 6 tools x 1d each = 6d alone.
- Track E: 2-3d claim -> 5-8d real.

### Reviewer F (goal alignment)

- "From my own farm" is **violated by jsdelivr CDN** for sql.js - every
  generated app phones home on load. v1 didn't name it.
- "Like those sites" feel breaks on **iteration speed**: 70B local + a
  multi-round tsc-fix loop could make "change the button color" a
  90-second wait. That kills the lovable comparison.
- The demo "agent that watches GitHub PRs -> daily Slack digest" silently
  doesn't work today because there's no Slack tool, no GitHub tool, no
  email tool. Tool catalog is the agent killer.

## The five tracks (revised)

### Track A - BYOK with local default (4-5 days)

**Goal**: Any one of Anthropic / OpenAI / local Ollama / vLLM gets you the
full LLM-driven draft + iteration experience. Local is the preferred
default on a 1.5TB RAM farm.

**Why this is smaller than v1**: Reviewer D confirmed
`src/providers/{anthropic, openai, ollama, minimax}.ts` already exist and
`ProviderRouter` already routes between them. The work is wiring callers
(`generateAppDraftViaLLM`, `applyAppIterationViaLLM`) through the router
with a local-first preset map, NOT writing new providers.

**Why it's not smaller still**: XGrammar integration, retry-with-correction
loop, per-provider policy, and the realistic 50% time buffer all eat real
hours.

**Deferred to Phase 3.5**: Gemini + OpenRouter. Both genuinely need new
adapters and Gemini's streaming format quirks are 1-2 days alone. Cut.

**Concrete deliverables**:

- Re-route `generateAppDraftViaLLM` + `applyAppIterationViaLLM` through
  `ProviderRouter` instead of straight to `AnthropicProvider`. (~0.5d)
- Add a model-preset -> provider+model resolver that picks based on
  configured env: prefer local if `OLLAMA_BASE_URL` or `VLLM_BASE_URL` is
  set with a recommended model present; else Anthropic / OpenAI in that
  priority for hosted. (~0.5d)
- **Per-provider policy** layer: local providers default to single-file
  tool calls and multi-turn iteration; hosted providers default to
  multi-file tool calls per turn. Encoded as a `ProviderPolicy` object
  per registered provider. (~1d)
- **XGrammar / structured decoding** when the provider is vLLM. Add
  `grammar` request param when the route supports it. Falls back to
  best-effort JSON parsing when not. (~1d)
- **Retry-with-correction** loop in `generateAppDraftViaLLM`: when the
  model emits malformed tool_use input, send the schema + the specific
  parse error back as a correction prompt, cap at 1 retry. (~0.5d)
- Updated model defaults: `cheap` -> `qwen2.5-coder:7b` /
  `claude-haiku-4-5-20251001`; `fast` -> `qwen2.5-coder:32b` /
  `claude-sonnet-4-6`; `smart` -> `qwen3-coder-next` /
  `claude-sonnet-4-6`; `top` -> `qwen3-coder-480b` / `claude-opus-4-7`.
  (~0.5d)
- Update `docs/SELF_HOST.md`: promote local to the recommended path,
  give Anthropic + OpenAI honest one-paragraph each, mention Gemini +
  OpenRouter as Phase 3.5. (~0.5d)
- Tests: 4-5 new tests covering provider-routing decisions,
  policy-driven turn shape, XGrammar fallback, retry-with-correction.
  (~1d)

**Hardest part**: Per-provider policy gets messy fast when the router
also has to decide between "use the smart preset with hosted Claude" vs
"use the smart preset with local Qwen3-Coder-Next." The decision matrix
is small but every entry has a different streaming + tool-use shape.

**Demo at the end of Track A**: With `OLLAMA_BASE_URL` set and
Qwen3-Coder-Next pulled, type "build me a kanban for renewals" in
/builder. Watch the local model emit prose + a working structured draft.
No Anthropic key needed.

---

### Track B - File-tree as source of truth (9-12 days)

**Goal**: Replace the 5-template prison
(`chooseTemplate` + `TEMPLATE_DEFINITIONS` + `renderGeneratedAppTsx`) with
an LLM that authors the actual file tree via `write_file(path, content)`
tool calls. Plan-then-write loop, validated by a real `tsc + vite build`.

**Why this is hard**: Reviewers A and E independently flagged this as the
single most under-budgeted track in v1. The tsc-feedback loop alone is a
real eval harness; LLMs emit broken TS in interesting ways; debugging
streamed tool_use accumulation across 10-25 files is the easiest place to
lose a week.

**Architectural decision**: file-tree is the source of truth. The
existing `AppBuilderDraft` shape (pages, apiRoutes, dataSchema) becomes a
**derived view** computed from the file tree, not a parallel data model.
This means iteration changes propagate through the files only;
checkpoints store the file tree.

**Concrete deliverables**:

- New file `src/codegen/llm-author.ts` - orchestrates the plan-first /
  write-second loop. Single entry: `authorAppViaLLM(prompt, options,
emit) -> { files, summary }`. (~2d)
- New file `src/codegen/prompts.ts` - system prompts for the plan phase
  and the write phase. Includes a skeleton template (Vite + React +
  Tailwind + Tailwind config + tsconfig + index.html) in the system
  prompt so the model has a starting structure but isn't forced to
  match it byte-for-byte. (~1d)
- New file `src/codegen/validate.ts` - runs the generated tree through
  the existing `src/sandbox/sandbox-service.ts` to invoke
  `tsc --noEmit` + `vite build`, captures errors. If validation fails,
  emits one retry prompt with the errors + cap. (~1.5d)
- Delete `chooseTemplate`, `TEMPLATE_DEFINITIONS` (~lines 214-487 of
  `app-builder-service.ts`), the `render*` helpers. (~0.5d for the
  deletion + the test-cascade fallout.)
- New file `src/codegen/derived-draft.ts` - projects a `AppBuilderDraft`
  from a file tree: parse `App.tsx` for pages, route table for
  apiRoutes, schema files for dataSchema. Used to populate the existing
  Files tab + Smoke tab without changing the consumer code. (~1.5d)
- Path validator (shared with Security track): every `write_file` path
  is resolved, normalized, validated against workspace root,
  Windows-specific checks (ADS, reserved names, case collision). (~0.5d
  here, ~0.5d in Security.)
- Streaming UI changes in `web/src/workbench/views/builder.tsx`:
  per-file progress in the Files tab as the tree lands. (~1d)
- Iteration: `applyAppIterationViaLLM` now operates on the file tree,
  not on the structured draft. (~1.5d)
- Tests: file-tree authoring with mocked SDK, path-traversal attempts,
  validation failure + retry, derived-draft projection round-trip.
  (~2d)

**Hardest part**: The retry-with-correction loop on broken TypeScript.
The scope deliberately caps at **1 retry**, then surfaces errors to the
user in chat ("the build failed with 3 errors, want me to try fixing
them?"). Multi-round auto-fix is the multi-week sinkhole reviewer E
flagged.

**Demo at the end of Track B**: "Build a meeting room scheduler with
calendar UI and ICS export." LLM writes ~15-20 files, build passes, the
preview renders a working scheduler. No CRM-shaped output forced on a
calendar-shaped problem.

---

### Track C - Real persistence + per-app runtime (5-7 days)

**Goal**: Generated apps stop using sql.js-in-browser. Per-app SQLite
files on the farm; a small Node runtime serves the app's API routes. Data
survives reloads, two browsers see the same state.

**Why this lands the "from my own farm" promise**: kills the jsdelivr
CDN dependency for sql.js that Reviewer F caught.

**Why it's bigger than v1**: `better-sqlite3` on Windows is a
native-module fight (0.5-1d of node-gyp / prebuild grinding). Per-app
child-process lifecycle (spawn, health, shutdown, crash recovery, port
assignment, log capture) is 2-3 days the v1 reduced to a footnote.

**Concrete deliverables**:

- Replace metadata-only `src/generated-app-runtime.ts` with a real
  per-app runtime. Each app gets its own Node child process, started on
  first request, kept warm with an LRU pool. (~2d)
- New file `src/generated-app-runtime/sqlite.ts` - thin wrapper around
  `better-sqlite3` (or Node's built-in `node:sqlite` if it works for
  our case) keyed by appId. Schema bumped via a `__schema_version`
  table; on mismatch, regenerate from the draft. **Old data is dropped
  on schema change** - documented constraint, not silent corruption.
  (~1d)
- `src/app-routes.ts`: extend `/api/app/generated-apps/:appId/api/*` to
  proxy to the per-app runtime. (~1d)
- Generated app template (in `src/codegen/prompts.ts`): use server API
  calls (`fetch('/api/...')`) instead of `useState` or sql.js.
  Generated apps still ship Vite + React + Tailwind. (~0.5d)
- Auth: **out of scope** for Phase 3. Generated apps run inside
  PacketAgent's auth boundary by default (only the workspace can hit
  them). Documented.
- Migration: **out of scope**. New drafts use the server runtime; old
  drafts stay on sql.js until remade. Documented as a Phase 3.5 item.
- Tests: per-app SQLite open/close/concurrent-access, schema-version
  bump drops + regenerates data, proxy preserves request body and
  status. (~1d)

**Hardest part**: Process supervision on Windows. The crash-recovery
story has to deal with Windows process-spawn quirks. Plan a day buffer
just for that.

**Demo at the end of Track C**: Open a generated scheduler in two
browser tabs. Book a meeting in tab 1. Refresh tab 2, see the booking.
Reload everything, data is still there.

---

### Track D - Agent path (5-7 days)

**Goal**: User says "build me an agent that pulls open PRs from my
GitHub, summarizes them, posts a daily digest to Slack." LLM authors the
agent definition. User approves tool perms inline. Agent runs on the
farm on schedule.

**Why this is much smaller than v1**: Reviewer D found the scaffolding
already shipped - `src/jobs/cron.ts` + `scheduler.ts` (full cron parser +
leader-lock), `src/webhook-routes.ts` (intake + token rotation),
`src/tools/registry.ts` (15-tool registry pattern), `agent-templates.ts`

- `agent-runs.ts` + `agent-runs-read.ts` (real repo pattern with 6
  templates and parity tests). Track D is reuse + 6 new tools + UI parity,
  NOT a from-scratch build.

**Why it's not smaller still**: 6 new tool integrations x ~1d each = 6
days alone. Reviewer F was right that the tool catalog is the agent
killer.

**Concrete deliverables**:

- **Six new tools** registered via the existing
  `src/tools/registry.ts`:
  - `http_fetch` (GET/POST/PUT/DELETE, auth headers, JSON helpers)
  - `slack_post_webhook` (incoming-webhook URL approach; user's own
    webhook URL, not OAuth)
  - `github_api` (PAT-based; list_prs, get_pr, get_comments,
    create_comment)
  - `email_send` (SMTP-based; user configures
    `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`)
  - `sql_query` (per-agent SQLite, scoped to the agent's own data
    store)
  - `shell_for_agent` (sandboxed via existing
    `src/sandbox/sandbox-service.ts`; capability-restricted, no
    network by default)
    Each tool is ~1d including auth, retry, error surfaces, perms
    declaration, and a unit test.
- **Agent-builder UI parity** with app-builder: same chat-thread
  composer at /builder switches between app and agent intent based on
  the chip / chip-derived prompt. (~0.5d - most of this exists in
  `web/src/workbench/views/builder-agent.tsx` already.)
- **Tool permissions inline prompt** (twin.so pattern): when an agent
  is about to invoke a tool for the first time, surface a
  Launch/Edit/Cancel prompt in the chat. (~1d)
- Wire agent intent into the LLM path: when the prompt is agent-shaped,
  call a slightly different system prompt that produces an
  `AgentTemplate` shape (already exists in `agent-templates.ts`)
  instead of an `AppBuilderDraft`. (~0.5d)
- Reuse existing scheduler + webhook intake - no new work.
- Tests: each new tool, agent-intent classification, perms prompt flow.
  (~1d)

**Hardest part**: Slack and email tools both need secret storage. The
existing `src/secrets-*` files (per Reviewer A) should be used; verify
on first day before starting the tools.

**Demo at the end of Track D**: "Build an agent that watches my open
GitHub PRs and posts a summary to #engineering every weekday at 9 AM."
LLM authors the agent. User pastes PAT + Slack webhook URL when
prompted. Agent runs on schedule. The digest actually arrives in Slack.

---

### Track E - Sandbox + farm infrastructure (3-4 days)

**Goal**: Real `tsc` + `vite build` invocation against the generated
tree. No model pool - solo owner runs one model at a time.

**Why this is smaller than v1**: `src/sandbox/{docker-driver,
native-driver, sandbox-service}.ts` already exist. Track E is wiring +
real-invocation, not new sandbox infrastructure. Model pool dropped per
Reviewer F (overkill for solo owner; ship if/when contention appears).

**Concrete deliverables**:

- Wire `src/codegen/validate.ts` (Track B) to invoke the existing
  sandbox service to run `tsc --noEmit` + `vite build` against the
  generated tree, capture real exit codes + stderr. (~1d)
- Remove the synthetic smoke-pass default - make sandbox the default,
  with an opt-out for environments without Docker. (~0.5d)
- **Egress allowlist enforcement** at the sandbox boundary, not just
  documented. Use Docker `--network none` by default, then a per-app
  bridge network with iptables egress filtering when an allowlist is
  declared. (~1d)
- Resource limits: per-build CPU + memory caps so a runaway build
  doesn't take down the farm. (~0.5d)
- `docs/SELF_HOST.md`: a "Configure the sandbox" section explaining
  Docker vs native, the egress policy, and where build logs land.
  (~0.5d)

**Hardest part**: egress filtering on Windows-hosted Docker (Docker
Desktop's networking is non-trivial). May need to defer the
egress-filter portion to Phase 3.5 if Docker Desktop turns out to be a
quagmire.

---

### Security - Cross-cutting (3-4 days)

**Goal**: Don't ship the foot-guns Reviewer C identified.

**Concrete deliverables**:

- **Drop `node:vm` sandbox option entirely.** Default sandbox = existing
  Docker driver in `src/sandbox/docker-driver.ts`. For users without
  Docker, add a **Deno subprocess** sandbox option: spawn `deno run
--allow-fs-read=<workspace> --allow-fs-write=<workspace>
--allow-net=<allowlist>` per per-app runtime. Works on Windows.
  (~1d)
- **Hardened path validator**: `src/codegen/path-validator.ts`. Every
  LLM-emitted `write_file` path goes through: `path.resolve` ->
  `fs.realpath` -> assert starts with workspace root -> reject Windows
  reserved device names (`CON`, `PRN`, `NUL`, `AUX`, `COM1-9`,
  `LPT1-9`) -> reject colons (NTFS ADS) -> reject trailing dots/spaces ->
  reject UNC paths (`\\server\share`, `\\?\`) -> normalize case for
  collision check. (~0.5d)
- **`process.env` scrubbing**: every spawned process (sandbox build,
  per-app runtime, agent tool execution) spawns with an explicit env
  whitelist (`PATH`, `NODE_ENV`, `APP_DATA_DIR`, `HOME` on POSIX,
  `USERPROFILE` on Win32, plus declared-and-approved app env). Never
  `{ ...process.env, ... }`. (~0.5d)
- **Network egress deny-by-default + per-app declared allowlist + SSRF
  blocklist**: hard-coded reject for `169.254.169.254` (AWS / Azure /
  GCP metadata), `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`, `0.0.0.0`. DNS
  pinning at allowlist-check time defeats DNS rebinding. (~0.5d)
- **Same-origin CSRF fix for preview**: serve the generated app preview
  from a different port (e.g. `8485` for preview vs `7341` for the
  Builder), so the LLM-authored `fetch('/api/internal-admin')` doesn't
  carry the user's PacketAgent session cookie. (~0.5d)
- **Typed agent capabilities per resource**: extend the existing
  `src/tools/registry.ts` so each tool declares typed capabilities
  (`http.fetch:GET:api.github.com`, `fs.write:/workspace/agent-id/`).
  Approvals stored per-tool-per-resource, not per-tool-globally. A
  runtime enforcer wraps every tool call. (~1d)

**Hardest part**: Same-origin CSRF fix needs reverse-proxy /
routing-table changes in dev (`vite.config.ts` proxy) and a clear story
in prod (separate port? subdomain?). Pick one early.

## Realistic budget

| Track                     | Days | Real dep                          |
| ------------------------- | ---- | --------------------------------- |
| A - BYOK                  | 4-5  | (none)                            |
| B - File-tree codegen     | 9-12 | A, E                              |
| C - Persistence + runtime | 5-7  | B                                 |
| D - Agent path            | 5-7  | A, C (locally)                    |
| E - Sandbox + farm        | 3-4  | (none, but unblocks B's validate) |
| Security - Cross-cutting  | 3-4  | weaves through all                |

**Total**: 29-39 focused days. **Calendar**: 6-9 weeks for a solo
engineer at ~60% focused time.

**Suggested phasing**:

- **Weeks 1-2**: Tracks A + E in parallel (foundations: BYOK router +
  real sandbox).
- **Weeks 3-5**: Track B (the substance pivot, with B-internal Security
  items).
- **Weeks 6-7**: Track C.
- **Weeks 8-9**: Track D + remaining Security cross-cuts.

This phasing puts the foundations first, the user-visible substance
next, persistence after that, and agents last. If anything slips, agents
slip - apps still work.

## What this scope does NOT include

- **Gemini provider** - Phase 3.5. Streaming + tool-use quirks are real.
- **OpenRouter provider** - Phase 3.5. Capability-matrix probing + free
  tier rate limits are real engineering, not adapter writing.
- **Multi-model pool / per-GPU routing** - solo owner runs one model at
  a time; ship if contention appears.
- **Multi-round auto-fix** on broken TS - cap at 1 retry, surface errors
  to chat. Multi-week sinkhole otherwise.
- **Auth on generated apps** - they live inside PacketAgent's auth
  boundary by default.
- **Migration of existing sql.js-based drafts** to the server runtime -
  documented as Phase 3.5; new drafts get the runtime, old drafts stay.
- **Visual click-to-edit with direct DOM edits that bypass the LLM**
  (Replit Element Editor) - Phase 4.
- **Conversation forking / shareable build URLs** - overhyped per the
  2026-norms cross-cut. Skipped.
- **iOS / Android binaries** (anything.com moat), **free public
  subdomain + auto-TLS** (Replit / v0 / Lovable moat), **30+
  pre-wired OAuth integrations with proxied tokens** (Replit / twin
  moat), **cross-workspace User Memory** (twin moat) - all hosted-only
  per `CLOUD.md`. Out of scope by design.

## What "done" looks like

After Phase 3, the owner can:

1. Open `http://localhost:7341/builder` on the farm.
2. Type "build me a kanban for tracking customer renewals" or "build an
   agent that watches my GitHub for new PRs and posts a daily digest to
   Slack."
3. Watch a local model (Qwen3-Coder-Next on the farm, no per-token cost)
   author the actual file tree or agent definition, with **real
   token-by-token prose streaming**.
4. See a working preview that **persists data on a real per-app
   SQLite**, survives reload, talks to a real backend, serves multiple
   browsers.
5. Run the agent on a schedule with **real Slack / GitHub / email
   tools**, with **typed per-resource permissions** the user approves
   inline.
6. All without an Anthropic key, an OAuth proxy, jsdelivr's CDN, or
   any hosted PacketAgent service.
7. With sandbox defaults that don't leak API keys, don't expose cloud
   metadata, and don't `node:vm`-fallback to a fake security boundary.

That's the product the owner described. **6-9 calendar weeks of focused
work** gets there. Not 3.
