# Backlog

This backlog keeps PacketAgent aimed at one thing first: **create a bounded worker, deploy it, let it keep working, and always know what it did, why it stopped, what it cost, and whether it needs a person**.

It is intentionally not a phase list. Items are grouped by product outcome so we can ship useful vertical slices.

This file is the single implementation ledger for all remaining work and the
completed PA0/W/R gate history.
Dependency rationale, repository seams, verification mechanics, and
historical-plan reconciliation are supporting context in
[`dev/worker-implementation-loops.md`](dev/worker-implementation-loops.md);
that document must not introduce active work absent from this backlog. After a
gate passes, continue with the next dependency-ready unchecked loop here. All
automatic PA0, W1-W10, and R1-R8 loops have passed; no next automatic loop is
currently defined. "Later, not MVP" remains decision-gated.

## PacketAgent autonomous-worker flagship

These loops supersede the old builder-first priority order. Existing builder, agent, scheduler, webhook, tool, approval, vault, storage, and operations code should be reused rather than replaced.

### PA0 - Brand and repository foundation

Status: complete. The historical foundation branch was merged; `main` is the
current integration branch.

- [x] Clone TaskLoom history into an independent `PacketAgent` working directory without altering the source checkout.
- [x] Rename product, package, environment, storage, UI, Docker, documentation, and source identifiers.
- [x] Preserve `TASKLOOM_*` environment values and legacy default data files through a one-way compatibility layer.
- [x] Carry the only uncommitted TaskLoom worktree fix into the new branch.
- [x] Refresh every Markdown document, label historical plans, and add an authoritative Codex project handoff.
- [x] Pass typecheck, lint with zero errors, production web build, API tests, web tests, migration tests, diff check, and compatibility-only brand scan.
- [x] Close the inherited repo-wide Prettier baseline. All 326 inherited files were formatted in reviewable R1 batches, and `npm run format:check` is clean.
- [x] Reduce the inherited ESLint baseline of 145 warnings to zero while preserving the zero-error gate.
- [x] Review and remediate dependency advisories deliberately. Targeted non-major upgrades reduced the full and production audits from 11/5 findings to two package entries for one unreachable React Router RSC advisory; [`dev/r1-dependency-advisory-audit.md`](dev/r1-dependency-advisory-audit.md) records ownership, reachability, and the exact-pin decision. No forced fix was used.
- Gate: a clean PacketAgent checkout starts with new defaults and can read an existing default TaskLoom deployment without destructive migration.

### W1 - Canonical Worker contract

Dependencies: PA0.

- [x] Define versioned `WorkerDefinition`, `WorkerVersion`, `WorkerDeployment`, `WorkerTrigger`, `WorkerPolicy`, `WorkerRun`, and `WorkerCheckpoint` schemas.
- [x] Define lifecycle and terminal-state transition guards.
- [x] Project existing agent/workflow records into the new read model without breaking current APIs.
- [x] Record source provenance, including PacketADE flight, project, conversation, repository, and revision when supplied.
- Gate: passed 2026-07-27. Schema tests reject invalid state transitions, mutable deployed versions, missing bounds, and ambiguous trigger definitions.

### W2 - Worker persistence, versioning, and activation

Dependencies: W1.

- [x] Add repository support for JSON, SQLite, and managed Postgres modes.
- [x] Make deployed Worker versions immutable and addressable.
- [x] Implement draft, validate, deploy, activate, pause, resume, retire, and rollback operations.
- [x] Add activation idempotency and optimistic concurrency.
- Gate: passed 2026-07-27. One shared lifecycle scenario proves replay, stale-write conflicts, two-writer activation, rollback replacement, process reload, and export behavior across JSON, SQLite, and managed Postgres.

### W3 - Trigger and activation envelope

Dependencies: W1, W2.

- [x] Normalize manual, cron, webhook, alert, and queue inputs into one activation envelope.
- [x] Preserve trigger identity, delivery identity, timestamp, actor, payload reference, and trace context.
- [x] Deduplicate repeated deliveries without dropping legitimate repeats.
- [x] Route current scheduler and webhook entry points through the envelope.
- Gate: passed 2026-07-27. Crash injection and concurrent two-repository replay prove one delivery commits one version-pinned queued run and execution job across JSON, SQLite, and managed Postgres; changed-content key reuse conflicts, while distinct delivery IDs remain distinct occurrences.

### W4 - Bounded autonomous supervisor

Dependencies: W1-W3.

- [x] Wrap the current tool-using agent loop in plan, act, evaluate, checkpoint, and decide phases.
- [x] Enforce elapsed-time, iteration, provider-cost, failure, and tool-call budgets.
- [x] Require an exit predicate and explicit terminal reason.
- [x] Support cancellation and lease loss at every phase.
- Gate: passed 2026-07-27. Scripted endless tools, hung providers, provider failures, invalid evaluations, exact-cost exhaustion, operator cancellation at every phase, abort during an ignored provider signal, lease theft, stale revisions, and expired-lease takeover all terminate within finite provider/tool-call bounds. Runtime transitions and cursor checkpoints retain JSON, SQLite, and managed-Postgres parity.

### W5 - Checkpoint, recovery, and side-effect safety

Dependencies: W4.

- [x] Persist phase cursor, working memory, completed actions, artifacts, pending approvals, and remaining budgets.
- [x] Resume interrupted runs after process restart.
- [x] Add idempotency keys and effect receipts around mutating tools.
- [x] Quarantine runs when safe replay cannot be proven.
- Gate: passed 2026-07-27. Digest-chained full-state checkpoints, startup/periodic recovery, prepared/completed effect receipts, exact action-cursor resumption, corruption/uncertain-effect quarantine, scheduler restart coverage, and JSON/SQLite/managed-Postgres parity prove committed nonterminal work is not silently abandoned and completed mutations are not repeated.

### W6 - Permission and budget policy

Dependencies: W1, W4.

Status: complete.

W6.1-W6.5 are complete: validated versions compile normalized
tool/verb/resource tuples, deployments persist only version-bounded narrowed
grants, and every production Worker tool call is authorized again in
`executeTool` immediately before its handler. Opaque, workspace-scoped
credentials resolve only after that decision; Worker network calls pin
validated public DNS answers and deny redirects; autonomous command execution
requires the no-network Docker sandbox. Provider cost and externally billable
actions reserve workspace/deployment rolling capacity atomically before the
call, settle actual usage, and release abandoned holds after lease expiry.
Production registry entries now expose one-shot executor-guarded handlers, and
the adversarial matrix proves policy denial before credential resolution,
rolling reservation, effect preparation, or external I/O.

- [x] Replace whole-tool grants with verb/resource-scoped capabilities.
- [x] Resolve credentials by reference at execution time; never embed secret values in Worker packages.
- [x] Add per-run and rolling cost ceilings.
- [x] Default network, filesystem, shell, and external-write access to deny.
- Gate: passed 2026-07-27. Every production registry entry is covered through
  both executor and direct-access paths; direct Worker handler access and
  permit reuse fail closed. Redirects, alternate IP notation, DNS rebinding,
  linked/case-aliased host paths, hostile command arguments, credential
  mismatch, stale/tampered policy, policy-before-effect ordering, and
  concurrent rolling reservations are covered without an undeclared action or
  over-budget call.

### W7 - Attention, approval, and kill controls

Dependencies: W4-W6.

Status: complete.

- [x] Define and persist version-bound attention requests, approval grants,
      control commands, and notification delivery references with durable replay
      identities across JSON, SQLite, and managed Postgres.
- [x] Add pause, resume, stop, revoke, approve once, approve for run, and reject actions.
- [x] Persist pending attention state across restarts.
- [x] Add escalation deadlines and notification route references.
- [x] Make kill and revoke controls available independently of the authoring UI.
- Gate: passed 2026-07-27. Fresh-process approval resume and callback replay,
  both approve/reject and activation/revoke orderings, durable stop at every
  supervisor phase, and newly constructed headless operator routes leave no
  later action or runnable work. An operator can stop a run and revoke future
  activation without an authoring application.

### W8 - Worker observability, cost, and evidence

Dependencies: W2-W7.

Status: complete. The later W9/W10 and R1-R8 loops are also complete.

- [x] Add one Worker health/attention summary.
- [x] Roll provider calls, tool calls, effects, retries, queue time, approvals,
      checkpoints, budgets, artifacts, and outcome quality up by Worker version,
      deployment, and run with deterministic replay and explained source gaps.
- [x] Expose a chronological evidence trail and artifact manifest.
- [x] Add retention and redaction policy for prompts, tool payloads, and outputs,
      including bounded workspace jobs, read-only dry runs, deletion evidence,
      and terminal-only compaction.
- Gate: passed 2026-07-28. One workspace-scoped read model answers what is
  running, why, its immutable version/deployment, current hard-budget use,
  provider cost, last checkpoint, required attention, evidence, artifacts,
  source gaps, and outcome without client-side raw-table joins. Stable
  filter-bound cursors, reconnect semantics, redaction, accessible
  loading/error/empty states, tenant isolation, source-order replay, and
  JSON/SQLite/managed-Postgres parity are covered.

### W9 - PacketADE deployment handoff

Dependencies: W1-W7. Contract design may proceed earlier.

Status: complete. The later W10 and R1-R8 loops are also complete.

- [x] Implement the WorkerPackage contract in [`dev/packetade-packetagent-handoff.md`](dev/packetade-packetagent-handoff.md).
- [x] Add validate, deploy, update, activate, inspect, list-runs, pause, resume,
      rollback, and revoke endpoints through W2/W3/W7/W8 services.
- [x] Verify package provenance, schema version, integrity, local capability
      acceptance, and idempotency behind a workspace/actor-bound PacketADE
      credential.
- [x] Return progress, approval, completion, failure, and budget events to
      PacketADE through versioned pages and bounded SSE, with stable opaque
      IDs, `Last-Event-ID`, retention-window errors, and durable idempotent
      cursor acknowledgements.
- Gate: passed 2026-07-28. A serialized PacketADE scenario exercises
  validation, deployment, activation, client disconnect, durable-store
  serialization, fresh service reconstruction, cursor/evidence reconnect,
  inspection, update, pause/resume, rollback, and revoke without changing the
  pinned run or losing evidence. The real-network validation check is present
  and remains conditionally skipped until an operator supplies an endpoint,
  workspace, and PacketADE credential.

### W10 - PacketChat and PacketPhone routes

Dependencies: W7-W9.

Status: local gate complete. R1-R8 are also complete. Live
PacketChat/PacketPhone interoperability remains conditional on external
endpoints and credentials and is not an automatic implementation loop.

- [x] Add a versioned channel-neutral notification outbox with atomic
      event/evidence binding, stable idempotency, bounded retry/expiry,
      dead-letter state, opaque route references, redacted delivery metadata,
      scheduler delivery, retention pinning, and JSON/SQLite/managed-Postgres
      parity.
- [x] Deliver concise Worker updates into PacketChat through an encrypted
      route credential, pinned-network transport, stable progress replacement,
      bounded state/budget/checkpoint/evidence cards, and short-lived
      exact-binding open/inspect callbacks.
- [x] **W10.3 - PacketPhone controls:** deliver approve, reject, pause, stop,
      and revoke actions only when the PacketPhone actor and role are allowed
      by W7.
- [x] Bind each W10.3 token to action, workspace, deployment, run, attention
      request when applicable, immutable version digest, actor, audience,
      nonce, and expiry.
- [x] Consume W10.3 callbacks durably and reject stale, replayed,
      cross-workspace, cross-version, and already-resolved actions.
- [x] **W10.4 - Remote-control certification:** contract-test PacketChat and
      PacketPhone adapters against fake endpoints; race local and remote
      actions; rotate credentials; restart with pending deliveries; replay
      callbacks; and verify dead-letter recovery.
- [ ] Run live PacketChat and PacketPhone interoperability checks when those
      endpoints and credentials are available.
- Gate: passed locally 2026-07-28. Fake-endpoint adapters, both local/remote
  race orderings, credential rotation, pending-delivery restart, read-only and
  single-use callback replay semantics, and bounded audited dead-letter redrive
  preserve W7 policy, idempotency, and audit guarantees. Two bounded live
  delivery probes are registered and conditionally skipped because no external
  endpoint configuration is present.

## Post-W10 execution ledger

These were the only autonomous continuation loops after W10. Their completed
checklists are retained as gate history. No automatic loop follows R8.

### R1 - Repository health and historical finding re-audit

Status: complete as of 2026-07-29.

Supporting finding-by-finding evidence is maintained in
[`dev/r1-repository-health-audit.md`](dev/r1-repository-health-audit.md).
The first persistence slice closes managed pool churn, destructive-migration
integrity/restore checks, and target-only managed-backfill preservation; the
jobs slice closes the second writer and incomplete workspace scoping; and the
backend security slice closes production-start truth, import-safe bootstrap,
rate-limit/preview-token re-audit, baseline response headers/CSP, and
workspace-authorized opt-in artifact serving. The frontend slice additionally
closes render recovery, multi-secret
redaction, corrupt-row re-audit, the historical preview iframe contract,
audited dead controls, primary keyboard semantics, and stale web branding.
The persistence authority/cutover contract is now explicit, and deliberate
dependency remediation removed every critical, moderate, and low advisory
while recording the single unreachable React Router RSC exception.

- [x] Re-audit every still-relevant historical P0/P1 finding and close stale
      findings with evidence.
- [x] Finish the Prettier baseline in reviewable batches.
- [x] Reduce inherited ESLint warnings to zero and require an explicit type on
      every native React button.
- [x] Triage dependency advisories without blind or forced upgrades.
- [x] Close verified persistence, migration, queue, managed-pool, startup,
      redaction, rate-limit, CSP/header, artifact-scope, and dead-control
      findings.
- [x] Decide and document the persistence end-state before removing any
      compatibility facade.
- Gate: passed 2026-07-29. Every historical P0/P1 finding is fixed, proven
  stale, or assigned to a named later loop; typecheck, lint, formatting,
  production build, migration recovery, 30 web tests, and the 1,525-test API
  suite are green.

### R2 - Provider policy and key parity

Status: complete as of 2026-07-29.

- [x] Add per-provider generation policy and capability metadata.
- [x] Add vLLM structured decoding/XGrammar with tested fallback.
- [x] Add one bounded malformed-tool-input correction attempt.
- [x] Add Gemini and OpenRouter vault-key parity.
- [x] Consolidate provider/model catalogs and readiness reporting.
- Gate: passed 2026-07-29. Every runtime provider has one tested catalog and
  generation-policy contract; vLLM constrained decoding has one bounded
  compatibility fallback; malformed tool input can be corrected once without
  execution; and every hosted provider key can use the encrypted workspace
  vault. Typecheck, lint, formatting, production build, 30 web tests, and the
  1,552-test API suite are green.

### R3 - File-tree generation depth

Status: complete as of 2026-07-29.

- [x] Add targeted bounded repair prompts from real failure clusters.
- [x] Move legacy-template iteration to the file-tree path or a deterministic
      one-time conversion.
- [x] Stream per-file plan/write/validate progress.
- [x] Add file-level change review and targeted route/entity/component
      regeneration.
- [x] Add sandboxed package planning and workspace export as zip or git-ready
      files.
- Gate result: passed. New and converted legacy drafts use the canonical
  file-tree path; repairs and progress are bounded and reviewable; targeted
  regeneration restores unrelated mutations; and workspace-scoped checkpoint
  exports include a never-executed package plan plus digest provenance.
  Typecheck, zero-warning lint, formatting, production build, 32 web tests,
  and the 1,569-test API suite are green (1,565 passed with 4 intentional live
  interoperability skips).

### R4 - Generated-app runtime and self-host publish

Status: complete as of 2026-07-29.

- [x] Add runtime health, metrics, crash visibility, and documented pool
      limits.
- [x] Add health endpoints, static-asset manifest validation, and
      signed/checksummed artifact manifests.
- [x] Turn publish handoff into a verified local Docker Compose run path.
- [x] Add reverse-proxy/VPN examples and public-URL reachability verification.
- [x] Preserve accurate schema/data migration claims.
- Gate: an exported app can be integrity-checked, started, health-checked, and
  reached through the documented self-host path.
- R4.3 result: generated publishes now contain a single-service standalone
  Node/Vite/SQLite package with sealed build/runtime inputs, runtime validation
  of Vite's emitted asset manifest, a non-root read-only bounded Compose
  service, and a CLI that proves health, static delivery, CRUD, restart
  persistence, and cleanup against Docker. The subsequently completed R4.4
  added reverse-proxy/VPN examples and public reachability verification.
  Typecheck, zero-warning lint,
  formatting, production web build, 32 web tests, and 1,577 API tests pass
  (1,573 passed with four intentional live interoperability skips).
- R4.4 result: generated packages bind to loopback by default and seal current
  Caddy, nginx, and Tailscale examples. The reachability CLI requires HTTPS
  outside loopback, bounds DNS/TCP/TLS/HTTP work, refuses redirects, validates
  content types and certificates, and binds readiness to exact app/checkpoint
  identity. Typecheck, zero-warning lint, formatting, production web build,
  32 web tests, and 1,581 API tests pass (1,577 passed with four intentional
  live interoperability skips). The subsequently completed R4.5 reconciled
  migration truth.
- R4.5 result: preview health, sealed runtime config, standalone readiness/meta,
  publish guidance, and reachability all declare the exact
  `reset-and-reseed` schema policy. Same-schema persistence and destructive
  schema-change reseeding are characterized; generated SQL is explicitly
  reference DDL; and the real Docker certifier proves a stopped-service
  SQLite backup/mutate/restore round trip with complete cleanup.
- Gate result: passed. An exported app is checkpoint-bound and
  integrity-checked, runs as one hardened standalone service, validates its
  concrete static output, reports health and schema policy, passes exact-origin
  reachability, preserves same-schema data, and has a verified offline
  backup/restore path. Typecheck, zero-warning lint, formatting, production
  web build, 32 web tests, 34 focused backend tests, the publish
  materialization route, a real 20-step Docker certification, and 1,583 API
  tests pass (1,579 passed with four intentional live interoperability skips).

### R5 - Sandbox, egress, and preview isolation

Status: complete as of 2026-07-29.

- [x] Make real sandboxed TypeScript and Vite validation the default and remove
      synthetic success.
- [x] Define fail-closed non-Docker behavior (no supported untrusted fallback)
      and remove `node:vm` as a security boundary.
- [x] Enforce CPU, memory, process, timeout, filesystem, environment, and
      egress limits at the sandbox boundary.
- [x] Reuse W6 redirect, SSRF, IPv4/IPv6, and DNS-rebinding protections.
- [x] Isolate generated previews by origin with scoped cookies, CSP, and proxy
      rules.
- [x] Harden containers with non-root users, dropped capabilities,
      no-new-privileges, and process limits.
- Gate: untrusted generated code cannot inherit secrets or sessions, reach
  undeclared networks, or escape resource bounds.
- R5.1 result: generated-source validation is required by default and can no
  longer return skipped success. PacketAgent builds a lockfile/Dockerfile-
  addressed local Node 22 validator image, mounts generated input read-only,
  copies it into an ephemeral workspace, and runs real `tsc --noEmit` followed
  by `vite build` with Docker networking disabled. Builder smoke consumes those
  phase results and fails closed when Docker, image preparation, or execution
  is unavailable. `npm run verify:codegen-sandbox` proves the uninjected path.
  Design and verification evidence live in
  [`dev/r5-sandbox-isolation.md`](dev/r5-sandbox-isolation.md). Typecheck,
  zero-warning lint, formatting, production web build, 32 web tests, 62
  focused tests, the real Docker verifier, and 1,583 API tests pass (1,580
  passed with three intentional live interoperability skips). The subsequently
  completed R5.2 removed `node:vm` as a security boundary and made non-Docker
  untrusted execution fail closed.
- R5.2 result: Docker is the only supported untrusted-code driver. Official
  Node guidance forbids `node:vm` for untrusted code, and official Deno
  guidance recommends an additional OS sandbox/VM for arbitrary untrusted
  code, so PacketAgent does not claim a Deno-only fallback. The service refuses
  native execution on every ordinary/untrusted call even when its opt-in is
  set; the separate native path is owner/admin-only trusted-host diagnostics.
  Status/API/UI expose `isolated` versus `trusted-host-only` and whether
  untrusted execution is supported. An ESLint restriction plus a source
  inventory test prevent production `node:vm` imports. Canonical Workers and
  generated validation continue to require Docker. Typecheck, zero-warning
  lint, formatting, production web build, 32 web tests, 25 focused tests, the
  real Docker validator, and 1,586 API tests pass (1,583 passed with three
  intentional live interoperability skips). The subsequently completed R5.3
  consolidated resource, filesystem, environment, timeout, and egress
  enforcement.
- R5.3 result: one fail-closed policy resolver now validates command/stdin
  size, Docker working directories, explicit environment names and values, and
  requested wall-clock deadlines before driver start. Docker execution applies
  and persists the effective wall-clock, CPU, memory, PID, writable-tmpfs,
  deny-all-network, read-only-filesystem, and validated-environment policy;
  accepted environment values persist only as `[redacted]`. The driver adds
  private IPC, equal memory/swap bounds, process and file-descriptor ulimits,
  readonly trusted mounts, and a bounded kill path. JSON/SQLite parity,
  multibyte output truncation, hostile request, and route coverage pass.
  `npm run verify:sandbox-policy` proves a real container cannot write its
  root, can use only bounded `/tmp`, cannot reach an external IP, does not
  persist an explicit env value, and is killed at the requested one-second
  deadline. Typecheck, zero-warning lint, formatting, production web build, 32
  web tests, 51 focused tests, both uninjected Docker verifiers, and 1,598 API
  tests pass (1,595 passed with three intentional live interoperability
  skips). The subsequently completed R5.4 reused W6 hardened network
  protections for declared sandbox egress.
- R5.4 result: optional sandbox egress is an operator-allowlisted, bounded,
  GET-only prefetch performed by PacketAgent through the existing W6
  pinned-network client before command start. Exact origins, every A/AAAA
  answer, alternate IP forms, the connected address, response size/deadline,
  and redirect denial are enforced outside the untrusted process. Successful
  bodies and a receipt manifest are mounted read-only at `/input/egress`; the
  container still runs with `--network=none`. Durable JSON/SQLite receipts
  contain query-redacted targets, response metadata, byte counts, digests, and
  connected addresses; the broker does not copy response bodies or query
  values into receipts. Failed broker calls are audited and prevent Docker
  start. `npm run verify:sandbox-egress` proves one broker call, immutable
  materialization, query redaction, and continued real-container network
  denial. Typecheck, zero-warning lint, formatting, production web build, 32
  web tests, 66 focused tests, the real Docker verifier, and 1,608 API tests
  pass (1,605 passed with three intentional live interoperability skips). The
  subsequently completed R5.5 added generated-preview origin, cookie, CSP,
  messaging, and proxy isolation.
- R5.5 result: the workbench and generated previews now have different browser
  authorities. Production requires exact, different HTTPS hostnames; a
  different port on one hostname is refused because it does not isolate
  cookies. Primary sessions remain host-only. Versioned, checkpoint-bound
  read/interactive capabilities travel only in URL fragments, exchange for a
  Secure/HttpOnly/partitioned app-path cookie, and are revalidated on every
  preview/runtime request. Shared sessions are read-only. Generated documents
  receive per-response nonces, bounded CSP, and scope-specific framing; the
  Builder click-to-edit path now uses exact-origin/source, schema-validated
  messaging rather than parent DOM access. Dual-host Caddy/nginx examples and
  `npm run verify:preview-isolation` prove both route-denial directions,
  fragment/cookie exchange, session non-inheritance, CSP, bridge, and
  read-scope `403`. Research and evidence live in
  [`dev/r5-sandbox-isolation.md`](dev/r5-sandbox-isolation.md). Typecheck,
  zero-warning lint, formatting, the production web build, 33 web tests, 62
  focused preview/security tests, all four cumulative R5 executable verifiers,
  and 1,617 API tests pass (1,614 passed with three intentional live
  interoperability skips). The subsequently completed R5.6 closed container
  hardening and the cumulative R5 gate.
- R5.6 result: the validator image now defaults to numeric non-root even when
  launched outside the sandbox driver. The PacketAgent control-plane Compose
  service, standalone generated-app Compose package, and untrusted sandbox
  execution all declare non-root identity, read-only root, all capabilities
  dropped, no-new-privileges, bounded process counts, bounded writable tmpfs,
  and init/process reaping where applicable. Generated-app Docker
  certification now inspects the running container instead of trusting YAML.
  `npm run verify:container-hardening` resolves both real Compose contracts,
  inspects the built validator image, and proves live sandbox UID/GID,
  zero effective capabilities, `NoNewPrivs=1`, cgroup PID maximum, and denied
  root writes. Typecheck, zero-warning lint, formatting, the production web
  build, 33 web tests, 16 focused container/publish tests, all five cumulative
  R5 executable verifiers, and 1,620 API tests pass (1,617 passed with three
  intentional live interoperability skips). R5's untrusted-code containment
  gate is complete.

### R6 - Agent authoring and execution depth

Status: complete. R6.1-R6.6 passed their gates on 2026-07-29.

- [x] Wire the default SMTP transport through vault-backed credentials.
- [x] Add LLM-authored Worker/agent templates beyond the heuristic builder.
- [x] Show provider/model/key/capability readiness before first run.
- [x] Add editable memory/input examples and first-run evaluation.
- [x] Add signed, versioned agent/Worker import and export.
- [x] Consolidate legacy agent execution onto canonical Workers only after
      compatibility and migration tests pass.
- Gate: authored agents can be evaluated, moved between installs, and operated
  canonically without losing compatibility.

- R6.1 result: `email_send` now defaults to a Nodemailer-backed transport for
  legacy Agent runs and to the canonical runtime SMTP port for Workers.
  Workers accept only an immutable-version-declared, encrypted
  `smtp_config` vault reference; recipient policy approval precedes resolution,
  and the credential-bound sender plus TLS mode cannot be overridden by tool
  input. SMTP reuses W6 all-address public-target validation and address
  pinning, requires implicit TLS or mandatory STARTTLS with certificate
  validation and TLS 1.2+, disables message file/URL access, closes on abort,
  and returns only bounded secret-free delivery counts and message identity.
  `npm run verify:smtp` proves the encrypted-store, policy order, pinned
  transport, TLS, sender, default-path, and redaction contract without a live
  server. Design and research evidence live in
  [`dev/r6-smtp-transport.md`](dev/r6-smtp-transport.md). Typecheck,
  zero-warning lint, repository formatting, the production web build, 33 web
  tests, 35 focused adversarial tests, the seven-assertion verifier, and 1,628
  API tests pass (1,625 passed with three intentional live interoperability
  skips).
- R6.2 result: one bounded provider-routed call now authors reusable Agent
  template content through JSON Schema where supported and the same bounded
  best-effort contract elsewhere. Local semantic validation constrains
  registered tools, deterministic triggers/schedules, typed non-sensitive
  inputs, playbooks, checks, and secret-like text. Invalid, incomplete,
  unavailable, or failed provider output falls back visibly to the
  deterministic builder. Approved agents retain existing APIs and project as
  valid draft Worker versions; R6.6 remains the canonical-only execution gate.
  `npm run verify:agent-template` performs no live calls and certifies the
  authoring and Worker-projection boundary. Research and design evidence live
  in
  [`dev/r6-agent-template-authoring.md`](dev/r6-agent-template-authoring.md).
  Typecheck, zero-warning lint, repository formatting, production web build,
  34 web tests, 79 focused backend tests, the seven-assertion verifier, and
  1,632 API tests pass (1,629 passed with three intentional live
  interoperability skips). The subsequently completed R6.3 added
  provider/model/key/capability readiness.
- R6.3 result: Agent authoring, pre-run readiness, saved model, and restart-safe
  execution route now share one canonical preset resolution. The Builder shows
  the exact provider/model, secret-free environment/workspace-vault/local key
  source, registration state, unverified model availability, and streaming,
  tool-use, and structured-output support before save. Missing runtimes block;
  conditional capabilities remain explicit for R6.4 evaluation; and local
  keyless configuration is never mislabeled as a verified model. Stable
  provider routes survive process reconstruction while the saved exact model
  prevents default drift. `npm run verify:agent-readiness` certifies this
  boundary without live provider calls. Research and design evidence live in
  [`dev/r6-agent-readiness.md`](dev/r6-agent-readiness.md).
  Typecheck, zero-warning lint, repository formatting, the production web
  build, 35 web tests, 83 focused backend tests, the seven-assertion verifier,
  and 1,635 API tests pass (1,632 passed with three intentional live
  interoperability skips). The subsequently completed R6.4 added editable
  memory/input examples and first-run evaluation.
- R6.4 result: the Builder and Agent editor now persist bounded non-secret
  memory, typed input examples, expected-output review context, and required
  evaluation tools. Builder approval saves examples before readiness or
  approval gates, then runs the real bounded Agent loop instead of fabricating
  a successful preview. Tool-capable evaluations retain the existing explicit
  launch approval. The versioned first-run evidence compares saved and actual
  inputs, run status, non-empty redacted output, and successful required tool
  calls; expected output remains visible operator-review context rather than a
  fabricated second-model score. Evaluation evidence survives JSON, SQLite,
  and managed-Postgres storage, is included in dedicated Agent-run backfill and
  verification, and appears in Builder, Agent run detail, and the run trace.
  `npm run verify:agent-first-run` certifies the boundary without network
  calls. Research and design evidence live in
  [`dev/r6-agent-first-run-evaluation.md`](dev/r6-agent-first-run-evaluation.md).
  Typecheck, zero-warning lint, repository formatting, the production web
  build, 37 web tests, 81 focused backend tests, the seven-assertion verifier,
  and 1,642 API tests pass (1,639 passed with three intentional live
  interoperability skips). The subsequently completed R6.5 added signed,
  versioned Agent/Worker import and export.
- R6.5 result: `packetagent.agent-worker-bundle/v1` now carries the complete
  portable authored Agent configuration plus its deterministic canonical
  Worker draft projection. RFC 8785 canonical bytes, SHA-256 digests, exact
  DSSE framing, and an Ed25519 install identity bind the envelope; strict
  validation rejects unknown fields, unsupported versions, projection/digest
  drift, changed payload bytes, malformed keys, and invalid signatures before
  any write. Production signing is domain-separated from `MASTER_KEY`;
  configured publisher fingerprints are read from
  `PACKETAGENT_AGENT_BUNDLE_TRUSTED_KEY_IDS`, while a valid unconfigured
  fingerprint requires explicit admin acknowledgement. Export omits all
  workspace/user/Agent/provider/playbook/memory IDs, provider destinations,
  credentials, webhook tokens, run/evidence/publish history, and active state.
  Import preflight exposes signature/trust and provider/tool readiness; the
  idempotent mutation assigns fresh IDs, persists a digest/fingerprint audit
  receipt, and always lands paused with a draft Worker projection. The
  Projects and Agent editor surfaces expose reviewed import and download
  flows. `npm run verify:agent-portability` certifies the eight-part boundary
  without network calls. Research and design evidence live in
  [`dev/r6-agent-worker-portability.md`](dev/r6-agent-worker-portability.md).
  Typecheck, zero-warning lint, repository formatting, the production web
  build, 39 web tests, 11 focused portability/package tests, the
  eight-assertion verifier, and 1,647 API tests pass (1,644 passed with three
  intentional live interoperability skips). The subsequently completed R6.6
  consolidated legacy Agent execution onto canonical Workers.
- R6.6 result: every accepted legacy Agent launch now materializes one
  deterministic canonical Worker definition, immutable content-derived
  version, compiled deployment, idempotently admitted Worker run, and
  `worker.run` job before provider or tool work begins. Agent run records are
  compatibility read models linked to canonical definition/version/deployment/
  run IDs; cancel propagates through W7 Worker control. Active Agent schedules
  migrate to canonical cron activation, queued legacy schedule jobs are
  canceled, and failed projection makes the last deployment inert. An
  approval-bound resource sentinel lets legacy whole-tool declarations request
  concrete actions without granting wildcard resources; exact canonical
  approval remains the runtime authority. JSON, SQLite, and managed-Postgres
  persistence carry the canonical links. `npm run
verify:agent-canonical-execution` certifies the eight-part boundary without
  network calls. Research and implementation evidence live in
  [`dev/r6-agent-canonical-execution.md`](dev/r6-agent-canonical-execution.md).
  Typecheck, zero-warning lint, repository formatting, the production web
  build, 39 web tests, focused execution/migration/persistence coverage, and
  the eight-assertion verifier pass. The 1,660-test API suite passes with 1,657
  passed and three intentional live interoperability skips. R6 is complete;
  the now-completed R7 and R8 gates are recorded below.

### R7 - Builder and frontend maintainability

Status: complete. R7.1-R7.5 and the gate passed on 2026-08-01; evidence lives
in [`dev/r7-frontend-maintainability.md`](dev/r7-frontend-maintainability.md).

- [x] Split remaining oversized views and routes along established seams.
- [x] Add shared accessible loading/error/empty boundaries and keyboard-safe
      primitives.
- [x] Remove duplicate client fetch/format utilities after characterization.
- [x] Make styling direction explicit and migrate incrementally.
- [x] Add stable component/browser coverage for Builder app and Worker modes.
- Gate: passed 2026-08-01. Critical views have accessible state handling,
  bounded ownership, component regressions, and an authenticated real-browser
  Builder/Worker/keyboard pass.

### R8 - Release reliability and production packaging

Status: complete. The requirement/evidence matrix and packaging decision live
in [`dev/r8-release-reliability.md`](dev/r8-release-reliability.md).

- [x] Persist smoke transcripts per generated-app checkpoint.
- [x] Add focused app and Worker happy paths through build, approval, run,
      inspect, reconnect, publish/deploy, and stop.
- [x] Add path-traversal, preview, artifact, rollback, backup/restore, and
      tenant-isolation regression tests.
- [x] Decide whether production images should run built JavaScript and prove
      source-map/Playwright compatibility.
- [x] Remove placeholder, demo-only, fake-success, and unsupported coming-soon
      claims from release surfaces.
- [x] Keep generated artifacts out of Git and document cleanup/reset.
- Gate: passed 2026-08-01. Twelve deterministic release groups, the built
  plain-Node server, actual non-root/read-only production image, backup round
  trip, browser/app/Worker paths, claim audit, and public documentation agree.

## Inherited capabilities already present

These capabilities were implemented before or during the TaskLoom foundation and are present in the PacketAgent working tree. They are recorded here so new Worker work reuses them instead of rebuilding them. This is implementation inventory, not the current priority list.

- **Full-bleed Builder.** `/builder` is now its own route outside the workbench Shell, with a chat thread, streamed prose, and a split preview. The Topbar no longer leaks into the builder.
- **Admin consolidation.** Twelve live operator surfaces (Roles, SSO, Secrets, Rate limits, Webhooks, Notifications, Operations, Integrations, Activation, Sandbox, Workflows, Billing) live under a single tabbed `/admin/:tab` page. Back-compat redirects keep supported old per-page URLs working.
- **Sidebar collapsed to four items.** Build, Projects, Runs, Admin. Removes the long secondary nav that competed with the Builder.
- **LLM wire-up via `ProviderRouter`.** Both `generateAppDraftViaLLM` and `applyAppIterationViaLLM` now route through `ProviderRouter`; iteration emits a real SSE prose stream. Template-only generation is the documented fallback when no provider is configured.
- **Six-provider BYOK at the builder.** Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and a generic local-LLM provider (Ollama / vLLM / LM Studio / llama.cpp) are first-class. Anthropic remains the default; `PACKETAGENT_PROVIDER_PRIORITY` re-orders the priority walk for every preset; the `local` preset is strict.
- **Remote-pointable local LLM.** `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_API_FORMAT` (`ollama` | `openai`), and `LOCAL_LLM_MODEL` let the local provider talk to a separate GPU box on the LAN. `OLLAMA_BASE_URL` is honored as a legacy synonym.
- **Preset -> provider+model resolver with env override.** `src/providers/preset-resolver.ts` walks per-preset priority lists, respects `PACKETAGENT_PROVIDER_PRIORITY`, and surfaces the resolved provider+model on Builder UI chips. `GET /api/app/builder/providers/status` exposes the resolution snapshot for ops verification.
- **Sentence case copy.** The uppercase kicker / eyebrow pattern is gone across the workbench. Section labels are sentence case.
- **Hide raw IDs.** IDs are now behind a Details disclosure rather than rendered in primary copy.
- **Per-message revert in chat.** Each chat message in the Builder has a revert affordance back to the prior checkpoint.
- **Click-to-edit default-on.** No mode toggle - text in the Builder is editable by default.
- **CI / CD vocabulary softened.** "Deploy" / "pipeline" jargon swapped for plain terms where it leaked.
- **Builder empty state redesigned.** Direction A composer + four starter chips, matching the twin.so / Lovable shape.
- **App-preview header replaced.** Minimal header in the preview pane instead of the workbench Topbar.
- **Fork B positioning docs.** `CLOUD.md` inventories hosted-only capabilities; `docs/SELF_HOST.md` is the canonical setup guide; README reframed as self-host first.
- **Generated app generator quality.** New deterministic generated apps now use the PacketAgent per-app SQLite runtime API instead of sql.js; the API is served by supervised per-app Node workers kept warm in an LRU pool. Continue improving realistic seed data, typed form controls, and generated UI polish.
- **OSS launch basics.** MIT license, security policy, `.env.example`, Dockerfile, Docker Compose starter, production startup hardening.
- **File-tree codegen orchestrator.** Plan-then-write loop drives the LLM through `write_file(path, content)` tool calls; lives in `src/codegen/llm-author.ts` with system prompts in `src/codegen/prompts.ts`.
- **File-tree codegen as the default path.** Runs by default when a BYOK provider key is configured; opt-out via `PACKETAGENT_LEGACY_TEMPLATES=1`. The previous `PACKETAGENT_FILETREE_CODEGEN=1` opt-in flag is preserved as a no-op.
- **Hardened path validator.** Windows-aware checks (NTFS ADS, reserved device names, UNC paths, trailing dots, case collision) in `src/codegen/path-validator.ts`. 10 rules, 25 tests.
- **`AppDraft` projection over a file tree.** `src/codegen/derived-draft.ts` reads `package.json`, `src/pages/*`, `src/api/*`, and `src/data/*` / `src/schema/*` so the Files tab, Smoke tab, and publish flow keep working unchanged.
- **File-tree iteration parity.** `src/app-iteration-service.ts` re-runs the orchestrator on an iteration-shaped prompt for file-tree drafts and diffs the new tree against the prior one. Falls back to the regex pipeline for legacy-template drafts.
- **Chunked planning for large apps.** Plans with more than 10 files are batched across multiple LLM rounds (chunks of up to 8 files each) with early-stop when a chunk returns nothing.
- **Vite-build validation alongside tsc.** `src/codegen/validate.ts` runs
  `tsc --noEmit` and then `vite build`; diagnostics are tagged with
  `phase: "typecheck" | "build"`. R5.1 made both phases mandatory through the
  Docker validator and retired the opt-in smoke flag.
- **Inline error UX in the Builder chat thread.** Validation errors from the file-tree path render inline as a warn-toned card with a "Fix these errors" button that triggers an iteration using the errors as the prompt.
- **Agent tool catalog adapters.** Six runtime tools are registered: `http_fetch`, `slack_post_webhook`, `github_api`, `email_send`, `sql_query`, and `shell_for_agent`, each with deterministic unit coverage and agent-builder recommendation hooks.
- **Agent tool launch approval UX.** Tool-enabled manual agent runs now return a signed, expiring capability approval request before execution. The agent editor shows Launch / Edit tools / Cancel, Launch replays the run with the approved tool set, and the backend verifies the token against workspace, agent, trigger, inputs, and registered tools.
- **Agent/playbook builder parity.** `/builder` now routes app and agent intents separately; agent mode opens the agent builder instead of starting app generation. Generated agent drafts include readiness, typed inputs, schedules/webhook guidance, playbook steps, and optional preview runs.
- **Run trace inspector.** Agent run detail now returns derived trace spans from run metadata, inputs, transcript, tool calls, logs, output, error, model, and cost. The run detail view renders the trace timeline with legacy fallbacks plus retry/cancel/diagnose actions.
- **Playbook authoring polish.** The agent editor validates playbook steps, trims saved instructions, improves reorder/remove controls, and requires a review step before replacing a playbook from a prior run.

## Completed inherited platform reconciliation

The former lower-priority inventory was executed as R1-R8. The dispositions
below are retained to prevent archived Phase 3 documents from recreating work
that has already shipped. The old Phase 3 labels survive only in the archived
[`docs/PHASE3_SCOPE.md`](docs/PHASE3_SCOPE.md).

### Provider policy

Completed in R2:

- per-provider generation policy and capability metadata;
- vLLM structured decoding/XGrammar with bounded best-effort fallback;
- one bounded malformed-tool-input correction; and
- encrypted workspace-vault parity for Gemini and OpenRouter.

### File-tree codegen

The orchestrator, default-on flip, path validator, derived-draft projection,
canonical legacy conversion, targeted bounded repair, per-file
plan/write/validate streaming, iteration parity, chunked planning, Vite-build
validation, file-level changed/unchanged review, targeted regeneration,
sandboxed package planning, zip/git-ready export, and inline error UX are
complete.

### Generated-app persistence and runtime

- Shipped: generated app templates emit same-origin `fetch('/api/...')` calls, the server owns a per-app `node:sqlite` file with `__schema_version`, schema changes drop and reseed app data, and each app runtime is isolated in a Node child process started on first request and kept warm with an LRU pool.
- Shipped: authenticated aggregate/per-app health endpoints and Builder
  visibility report process state plus bounded request, retry, crash, restart,
  and eviction metrics without starting idle runtimes. The documented warm
  pool defaults to four supervised child processes, clamps configuration to
  1-64, and evicts the least-recently-used idle process.
- Shipped: publish artifact manifest v2 binds immutable app/checkpoint identity,
  per-file bytes and SHA-256, a bounded HTML/CSS asset graph, and a canonical
  manifest digest with optional HMAC authenticity. Authenticated
  re-verification rejects tampering, substitution, unexpected files, unsafe
  paths, and symlinks.
- Shipped in R5.5: generated previews use a separate browser authority,
  scoped capabilities/cookies, CSP, and a bounded exact-origin message bridge.

### Existing agent path

- Shipped: six new tools are registered in the default runtime catalog (`http_fetch`, `slack_post_webhook`, `github_api`, `email_send`, `sql_query`, and `shell_for_agent`), manual tool-enabled runs now have the first-call Launch / Edit tools / Cancel approval flow, `/builder` separates app and agent intent, and run detail exposes a trace inspector.
- Shipped: legacy Agent launches, automatic schedules, control, evaluation, and
  read APIs now adapt to the canonical Worker lifecycle. Portable signed
  import/export, LLM-authored templates, provider readiness, editable
  memory/input examples, deterministic first-run evaluation,
  resource-scoped runtime enforcement, and the default hardened SMTP adapter
  are also complete.
- Shipped in R8: the focused canonical Worker happy path covers deployment,
  execution, inspection, reconnect, and revocation. Agent authoring and
  canonical execution are covered by the R6 characterization and executable
  gates; a real provider run remains operator-conditional.

### Sandbox and execution farm

- Shipped in R5.1: `src/codegen/validate.ts` invokes the required Docker
  validator for real `tsc --noEmit` plus `vite build`; there is no
  synthetic-success opt-out.
- Shipped in R5.2: Docker is the only untrusted-code driver. Without Docker,
  untrusted execution fails closed; the native host process is explicit
  owner/admin trusted diagnostics only.
- Shipped in R5.3-R5.4: resource limits are enforced at the Docker boundary;
  optional egress is a bounded, allowlisted PacketAgent prefetch whose output
  is mounted read-only while the untrusted container remains networkless.

### Cross-cutting security

- Resolved in R5.2: production `node:vm` imports are prohibited. A Deno-only
  subprocess is deliberately not claimed as a secure fallback because Deno's
  own untrusted-code guidance requires layered OS or VM isolation; no Docker
  means no supported untrusted execution.
- Resolved in R5/W6: spawned untrusted processes receive only validated
  environment entries; Worker networking is deny-by-default with public-address
  validation, DNS pinning, connected-address checks, and redirect denial.
- Resolved in R5.5: generated previews cannot inherit the workbench session and
  are constrained by scoped cookies, CSP, and exact-origin messaging.
- Resolved in W6: typed verb/resource capabilities are compiled against the
  immutable Worker version and rechecked immediately before every tool handler.

### MVP reliability

- Shipped in R8: every new generated-app checkpoint and each refresh,
  rollback, or branch carries a bounded versioned smoke transcript.
- Shipped across R7/R8: critical Builder and Worker states use explicit
  accessible loading/error/empty behavior, and the authenticated browser gate
  covers Builder app mode, canonical Worker operations, and keyboard tabs.
- Shipped in R8: the focused app path covers sign-in, build, approval,
  iteration, preview, and publish handoff; the focused canonical Worker path
  covers deploy, run, inspect, reconnect, and revoke.
- Conditional verification only: live provider/tool Agent execution requires
  operator-supplied provider credentials. Deterministic R6 gates cover its
  authored-to-canonical path without claiming external-provider certification.

### Builder depth

- Shipped in R3: file-level changed/unchanged/new/deleted review, targeted
  route/entity/component regeneration, zip/git-ready export, and
  never-executed package-install planning with sandboxed validation.

### Agent depth

- Shipped: provider/model/key/capability readiness before first run.
- Shipped: deterministic first-run evidence with expected inputs, actual
  output, required tool calls, and pass/fail notes.
- Shipped: bounded non-secret Agent memory and editable Builder/Agent input
  examples.
- Shipped: signed Agent import/export moves templates and generated Agents
  between installs without local IDs, secrets, active schedules, or run
  history; imports are reviewed and paused.

### Self-host publish

- Shipped: generated-app process health endpoints, bounded static-asset
  validation, checksum-sealed artifact manifest v2, optional HMAC authenticity,
  and authenticated package re-verification.
- Shipped: generated-app publish directories now include the standalone image,
  Compose service, runtime/model/runbook, and bounded Docker verification CLI.
- Shipped: loopback-by-default publish networking, sealed Caddy/nginx/Tailscale
  examples, and exact-identity public URL reachability verification.
- Shipped: one visible `reset-and-reseed` policy, same-schema and
  schema-change characterization, reference-only generated DDL, and a verified
  stopped-service SQLite backup/restore round trip.
- R5 isolation and R8 release/production-packaging gates are complete.

### Quality bar

- Run `npm run audit:release-claims` before every release; it rejects
  unsupported future, demo-only, fake-success, old phase-TODO, and public
  stub-provider wording.
- Keep `npm run typecheck`, `npm test`, `npm run build:web`, and the documented
  dependency-audit policy green. R1 owns the recorded advisory exception.
- Shipped in R8: regression tests cover generated workspace path traversal,
  preview route serving, publish artifact validation, and rollback.
- `npm run verify:workbench-browser` now captures ignored Builder app and
  canonical Worker operations screenshots while testing real sign-in and
  keyboard tab focus. Agent authoring remains covered by the stable component
  characterization suite.
- Keep generated artifacts out of git and document cleanup / reset commands.

## Decision-gated work

These are the only remaining product-expansion candidates recorded in this
ledger. They are not an R9 and must not start without an explicit owner choice.

### Later, not MVP

> Hosted-only capabilities (managed deploy with free public subdomain, hosted browser-agent farm, one-click App Store / Play submission, hosted OAuth proxy with pre-wired connectors, cross-tenant user memory, shareable / remixable conversation URLs, managed credit meter) are intentionally out of scope for self-host. See [CLOUD.md](CLOUD.md) for the inventory and what a hypothetical PacketAgent Cloud product would need to ship them.

- Collaborative multiplayer editing.
- Hosted cloud deployment managed by PacketAgent.
- Full browser IDE with arbitrary repo editing.
- Marketplace templates and shared plugins.
- Multi-region active-active runtime.
- Distributed SQLite or custom database replication.
- Visual click-to-edit with direct DOM edits that bypass the LLM (Replit Element Editor pattern) - possible Phase 4.
- Conversation forking / shareable build URLs - overhyped per the 2026-norms review; skipped.

## Historical portfolio audit dispositions - 2026-07-17

_Findings from a 2026-07-17 code audit, retained with their current
dispositions. They do not form a second active backlog._

### Dispositions

- **[resolved R1]** `/data/artifacts/*` is explicit-opt-in, requires a private
  viewer session, extracts a safe run ID, and verifies that the Agent or Worker
  run belongs to the active workspace before the scoped static handler runs.
- **[resolved R5.1]** Generated `tsc` plus Vite validation previously returned a
  synthetic pass unless `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1`.
  - Resolution: the flag is retired. A lockfile-addressed Docker validator now
    runs by default, and unavailable isolation produces `source: "blocked"`
    with `ok: false`.
- **[resolved R6.1]** `email_send` previously had no default SMTP transport.
  - Resolution: the default path is now Nodemailer-backed, TLS-only, public-address-pinned, bounded, and abortable. Autonomous Workers resolve strict encrypted `smtp_config` values only after recipient policy approval; legacy Agents retain `SMTP_*` environment compatibility.
- **[resolved W6/R6.6]** Legacy Agent Launch approval may still present a
  whole-tool authoring choice, but accepted execution materializes a canonical
  Worker and uses immutable-version-bound verb/resource policy plus an exact
  approval-bound resource at the runtime boundary. The authoring token is not
  execution authority.
- **[resolved R5.5]** Generated-app previews run on a distinct browser
  authority with host-isolated sessions, checkpoint-bound capability exchange,
  scoped cookies, CSP, exact-origin messaging, and proxy examples.
