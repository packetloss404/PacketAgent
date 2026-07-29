# Changelog

All notable changes to PacketAgent are tracked here.

This project follows the spirit of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and uses semantic versioning once releases are tagged.

## [Unreleased]

### 2026-07-29 - R5.2 fail-closed non-Docker execution truth

- Defined Docker as PacketAgent's only supported untrusted-code driver. There
  is no implicit native or Deno-only security fallback when Docker is absent.
- Split native host execution into an explicit trusted diagnostic service path;
  it still requires the operator opt-in and now also requires workspace
  owner/admin authorization. Ordinary sandbox calls, smoke batches, generated
  validation, and canonical Workers fail closed before the native driver
  starts.
- Added `executionClass` and `untrustedCodeSupported` to sandbox status and
  surfaced `trusted-host-only`/untrusted-blocked state in the workbench,
  including a disabled composer for non-admin native users.
- Added an ESLint production-import ban and source-inventory test for
  `node:vm`, following Node's explicit warning that it is not a security
  mechanism. Recorded why Deno permissions alone do not meet the arbitrary
  untrusted-code boundary.
- Typecheck, zero-warning lint, formatting, production web build, 32 web
  tests, 25 focused tests, the real Docker validator, and 1,586 API tests pass
  (1,583 passed with three intentional live interoperability skips).
- Resume at R5.3 consolidated resource, filesystem, environment, timeout, and
  egress limits.

### 2026-07-29 - R5.1 required generated-code sandbox validation

- Retired `PACKETAGENT_SANDBOX_SMOKE_ENABLED` and removed every
  skipped/synthetic-success path from generated TypeScript/Vite validation.
- Added a Dockerfile/lockfile-addressed Node 22 validator image, a trusted
  internal runtime/mount contract, read-only generated-source input, an
  ephemeral writable workspace, network denial, scrubbed Docker CLI
  environment, and bounded image preparation.
- Builder smoke now validates the concrete generated runtime with real
  `tsc --noEmit` and Vite exit codes. Missing Docker, image preparation, or
  execution fails closed and LLM authoring stops without spending repair turns
  on infrastructure failure.
- Added `npm run verify:codegen-sandbox`; its uninjected Docker path passes both
  phases. Typecheck, zero-warning lint, formatting, production web build, 32
  web tests, 62 focused tests, and 1,583 API tests pass (1,580 passed with three
  intentional live interoperability skips). Resume at R5.2 non-Docker
  isolation truth and removal of `node:vm` as a security boundary.

### 2026-07-29 - R4.5 generated-app schema and backup truth

- Declared one `reset-and-reseed` schema-change policy across preview health,
  the Builder UI, sealed runtime config, standalone readiness/meta, publish
  guidance, and reachability verification.
- Characterized same-schema record preservation and destructive
  schema-signature reseeding in both preview SQLite and the standalone process
  runtime.
- Labeled generated `0001_initial.sql` as reference DDL that the current
  generic runtime does not execute, and removed automatic-migration
  implications from generated and publish guidance.
- Added a stopped-service SQLite backup/restore runbook and extended real
  Docker certification to prove backup, mutation, restore, recovered data, and
  complete temporary-state cleanup.
- Closed the R4 gate and moved the active implementation ledger to R5.1 real
  sandboxed TypeScript/Vite validation after typecheck, zero-warning lint,
  formatting, production web build, 32 web tests, 34 focused backend tests,
  the publish materialization route, real 20-step Docker certification, and
  1,583 API tests passed (1,579 passed, four intentional live skips).

### 2026-07-29 - R4.4 generated-app proxy and reachability

- Bound standalone generated-app Compose ports to `127.0.0.1` by default;
  direct all-interface LAN exposure now requires an explicit bind-address
  override.
- Added sealed Caddy automatic-HTTPS, nginx TLS, and Tailscale Serve/private
  plus Funnel/public deployment examples to every publish package.
- Added `verify:generated-app-reachability` with bounded URL-policy, DNS,
  TCP/TLS, liveness, readiness-identity, and HTML-root checks. Public targets
  require HTTPS and valid certificates; redirects, oversized responses, wrong
  content types, and app/checkpoint substitution fail closed.
- Reused the reachability contract in Docker publish certification and
  documented that PacketAgent does not provision DNS, TLS, VPN policy, or
  continuous public monitoring.
- Closed the loop with typecheck, zero-warning lint, formatting, production
  web build, 32 web tests, 18 focused backend checks, real Docker
  certification, and 1,581 API tests (1,577 passed, four intentional live
  skips).

### 2026-07-29 - R4.3 verified generated-app Compose runtime

- Replaced inherited compose guidance that started the full PacketAgent server
  and an unused Postgres service with a package-local, single-service
  generated-app runtime.
- Added a multi-stage Node 22/Vite build. Dependency installation disables
  lifecycle scripts, Vite compilation runs with build networking disabled,
  and the final image contains only built static assets plus the standalone
  runtime/config/model.
- Added dependency-free health, static hosting, Vite output-manifest
  validation, and per-app SQLite CRUD with bounded request and manifest reads.
- Hardened the generated Compose service with a non-root user, read-only root,
  bounded tmpfs/CPU/memory/PIDs, dropped capabilities,
  `no-new-privileges`, readiness checks, and a named data volume.
- Added `npm run verify:generated-app-publish -- <directory>` to validate
  Compose, build/start/wait, health, static delivery, CRUD, restart
  persistence, and complete project/volume/image cleanup with bounded redacted
  output.
- Corrected publish readiness, artifact observations, URL handoff, package
  runbooks, and self-host documentation to describe the runtime that actually
  ships.
- Closed the loop with clean/cached Docker verification, typecheck,
  zero-warning lint, formatting, production web build, 32 web tests, and 1,577
  API tests (1,573 passed with four intentional live interoperability skips).

### 2026-07-29 - R4.2 generated-app artifact integrity

- Added generated-app artifact manifest v2 with workspace/app/checkpoint
  subject binding, sorted per-file media type, byte count, and SHA-256
  evidence plus a canonical manifest digest.
- Added bounded HTML/CSS static-asset graph validation and fail-closed missing,
  modified, unexpected, traversing, symlinked, oversized, and substituted
  package checks.
- Added optional HMAC-SHA256 manifest authenticity using a 32-byte minimum
  environment key; only the HMAC and non-secret key ID enter the artifact.
- Added authenticated, workspace-scoped publish re-verification and Builder
  file/byte/signature status while retaining read compatibility for legacy
  list-only manifests.
- Recorded the standards research, compatibility posture, and R4.3 handoff in
  `dev/r4-generated-app-publish.md`.
- Closed R4.2 with clean typecheck, zero-warning lint, formatting, production
  web build, 32 web tests, and 68 focused backend tests (67 passed, one
  intentional Windows sandbox skip).

### 2026-07-29 - R4.1 generated-app runtime operations

- Added authenticated workspace aggregate and owned-app generated-runtime
  health endpoints without starting idle app processes.
- Added process, active-request, request/outcome/retry/start/crash/
  schema-restart/eviction metrics plus bounded recent crash metadata that
  excludes raw error and secret content.
- Kept the existing one-retry supervision contract visible as degraded health
  for five minutes after request, startup, or unexpected-exit failures.
- Added per-app runtime status and counters to the Builder Sandbox tab.
- Documented the supervised warm-pool default of four child processes, the
  `PACKETAGENT_GENERATED_APP_RUNTIME_MAX_PROCESSES` setting, its 1-64 clamp,
  and least-recently-used idle eviction.

### 2026-07-29 - R3 file-tree generation depth

- Added deterministic TypeScript/Vite failure clustering and diagnostic/file
  budgets to the existing bounded validation repair loop.
- Converted persisted legacy template, structured-draft, and historical
  source bundles to the path-safe canonical file-tree iteration contract.
- Streamed typed, repair-attempt-aware plan/write/validate progress through
  Builder SSE routes and the Source view without treating skipped validation
  as success.
- Added full added/modified/deleted/unchanged file review with SHA-256 and size
  evidence while keeping apply payloads changes-only.
- Scoped page, API-route, data-entity, and selected-component regeneration;
  unrelated model mutations are restored before candidate validation.
- Added an allowlisted, semver-only package-install plan that never executes
  and records required Docker, registry-only, no-lifecycle-script bounds.
- Added authenticated checkpoint-bound git-ready ZIP export with unsafe-path,
  duplicate, 500-file, and 10-MiB source limits plus package and digest
  provenance.
- Recorded implementation and ZIP-library research in
  `dev/r3-filetree-depth.md`.
- Closed R3 with clean typecheck, zero-warning lint, formatting, production
  web build, 32 web tests, and the 1,569-test API gate (1,565 passed, 4
  intentional live Packet-product probes skipped).

### 2026-07-29 - R2 provider policy and key parity

- Added one canonical catalog for provider identity, model presets,
  environment lookup, capability metadata, workspace-vault eligibility,
  readiness, and hosted-versus-local generation policy.
- Mapped explicit workflow JSON Schemas to Anthropic `output_config`, strict
  OpenAI/Gemini/OpenRouter `response_format`, and current vLLM
  `structured_outputs` requests. Unsupported vLLM fields get one bounded,
  schema-prompted fallback.
- Preserved typed malformed-tool-input failures across every adapter, prevented
  invalid calls from executing, and allowed exactly one correction turn in the
  agent and Builder draft loops.
- Applied the catalog's local policy to file-tree authoring so local models
  write one planned file per turn while hosted providers retain bounded
  multi-file rounds.
- Added Gemini and OpenRouter to the encrypted workspace key form, runtime key
  resolver, integration readiness, provider types, SQLite migration, and
  JSON/SQLite/managed-Postgres parity tests.
- Expanded the provider status response with public capability, generation,
  readiness, and credential-source metadata without returning key material.
- Recorded the researched contract and conservative conditional-capability
  decisions in `dev/r2-provider-policy.md`.
- Closed R2 with clean typecheck, lint, formatting, production web build, 30
  web tests, and the 1,552-test API gate (1,548 passed, 4 intentional live
  Packet-product probes skipped).

### 2026-07-29 - R1 persistence authority and dependency security

- Defined the current control-plane authority for JSON, promoted/record-row
  SQLite, and advisory-lock-serialized managed-Postgres document storage,
  including staged cutovers, generated-app separation, compatibility writers,
  and the gates required before replacing the logical store facade.
- Corrected the README and deployment guide: the managed runtime does not use
  per-entity Postgres tables or continuous SQLite/Postgres dual-write, and its
  whole-document write throughput is globally serialized.
- Upgraded Hono, its Node adapter, React Router, Vite, PostCSS, concurrently,
  Babel, and brace-expansion without a forced or unrelated major change.
- Made PacketAgent's direct preview-runtime `esbuild` dependency explicit and
  pinned all consumers to the compatible advisory-free `0.27.2` release.
- Reduced both full and production dependency audits from 11/5 findings to two
  high package entries for one React Router RSC advisory. PacketAgent does not
  expose the affected RSC/server-action path; the deliberate exact-pin and
  re-audit trigger are documented.
- Converted the compatibility store facade's import-only type/value exports to
  direct re-exports, preserving its public API while removing 66 inherited
  ESLint warnings.
- Removed seven dead aliases, constants, caught-error bindings, and imports
  across alert, preview, rate-limit, invitation, metrics, template, and Worker
  observability modules; formatted the touched sources and passed 174 focused
  regressions.
- Replaced ten backend `any` assertions with Hono status types, a serialized
  dynamic workflow response boundary, and concrete activation/onboarding
  contracts; 113 focused route/service tests passed with one intentional
  Windows sandbox skip.
- Replaced the Anthropic and OpenAI factories' CommonJS `require` calls with
  native ESM imports and aligned the Anthropic stream interface with the SDK's
  synchronous async-iterable return.
- Closed the backend ESLint-warning baseline by removing dead builder publish
  helpers and unused iteration/runtime/workflow imports; 92 focused builder,
  runtime, and workflow tests passed with one intentional Windows sandbox skip.
- Split auth, toast, and workbench context state/hooks from component-only
  provider modules, stabilized auth callbacks and bootstrap state updates, and
  retained the existing import consumers through explicit state modules.
- Split command-palette, active-view, Builder starter/tour state, and preview
  copy from component-only modules; palette-open now remounts fresh local state
  instead of synchronously resetting it from effects.
- Replaced public-share, sandbox runtime/output, and reporting-window state
  resets with request-identity derivation, keyed execution panels, stable empty
  collections, and one render epoch for time-window summaries.
- Closed the inherited 145-warning ESLint baseline. The shared API loader now
  suppresses stale responses, and Builder tours, agent generation, run detail,
  iteration targets, and workspace forms reset by explicit identity or
  scheduled effects instead of synchronous effect-driven state writes.
- Audited all 123 native React buttons through the TypeScript syntax tree and
  added explicit non-submit types to the 64 that relied on browser defaults;
  formatted the workbench-view tree and reduced the Prettier backlog from 268
  files to 247.
- Formatted the backend activation, alerting, app-builder, codegen, database,
  deployment, generated-runtime, job, provider, repository, sandbox, security,
  service, store, tool, and Worker subdirectories, reducing the remaining
  Prettier backlog from 247 files to 123.
- Formatted the first half of the top-level backend routes, services, generated
  runtime, integrations, invitation delivery, and regression suites, reducing
  the remaining Prettier backlog from 123 files to 46.
- Formatted the final backend, web-library, CSS, script, documentation, and
  Tailwind files, closing the inherited 326-file Prettier baseline.
- Closed R1 with clean typecheck, lint, formatting, production web build,
  compatibility-only brand scan, 30 web tests, and the 1,525-test API gate
  (1,521 passed, 4 intentional live-probe skips).
- Passed typecheck, the production web build, 30 web tests, and the 1,525-test
  API gate (1,521 passed, 4 intentionally skipped live probes).

### 2026-07-28 - R1 persistence and queue correctness

- Reused one managed Postgres pool per connection target instead of opening and
  closing a pool for every store operation, while retaining dedicated
  transaction clients and adding graceful server-shutdown cleanup.
- Required SQLite migration and restore candidates to pass database integrity
  and foreign-key checks. Corrupt backups are rejected before they can replace
  the current database.
- Changed managed-Postgres backfill to preserve target-only records, keep the
  source authoritative for shared identities, and avoid no-op rewrites when
  the target only contains additional records.
- Started a current, evidence-linked R1 historical-finding audit without
  reviving archived review files as active ledgers.
- Passed the 1,517-test API gate: 1,513 passed, 4 intentionally skipped live
  Packet-product probes, and 0 failed.
- Removed the redundant SQLite jobs-table upsert after canonical store
  mutations, keeping document hydration and dedicated job persistence inside
  one `begin immediate` transaction so a claimed job cannot be reverted.
- Required workspace identity on every job find, update, and cancel boundary,
  rejected cross-workspace ID collisions during upsert, and added repository,
  route, scheduler, and claim/rewrite regressions. The focused queue gate passes
  91 tests.
- Made `npm start` launch the single-process production server without Vite or
  watch mode, and moved legacy migration plus provider/tool registration behind
  an explicit idempotent startup bootstrap.
- Added baseline Hono security headers and a restrictive same-origin workbench
  CSP while preserving the generated-app preview exception that R5 will replace
  with origin isolation.
- Required opt-in artifact reads to authenticate as a workspace viewer and
  authorize the exact URL run ID against that workspace before static serving.
  Owner, cross-workspace, anonymous, and legacy/canonical run cases now have
  direct regression coverage.
- Re-audited the rate-limit and generated-preview-token findings as already
  fixed, with current proxy-chain, hashed-identity, distributed fail-closed,
  and production-fallback rejection tests cited in the R1 evidence.
- Added a generic top-level React recovery boundary, a titled/sandboxed builder
  preview iframe, and complete multi-secret redaction for persisted app
  iteration metadata.
- Removed the advertised Alerts stub, replaced inert controls with honest
  status or live navigation, and converted primary navigation, tabs, role
  selectors, output selectors, and project cards to native keyboard-operable
  buttons.
- Replaced stale workbench, sign-in, logged-out, and public-share TaskLoom
  wordmarks with the canonical PacketAgent web brand configuration.
- Passed 23 focused backend safety tests, 30 web tests, typecheck, the production
  web build, and a local signed-out/signed-in browser inspection. The inherited
  baselines are reduced to 143 ESLint warnings and 311 Prettier files.

### 2026-07-28 - Local remote-control certification (W10.4)

- Certified the PacketChat and PacketPhone transports against fake hardened
  endpoints, including immutable binding, secret isolation, stable delivery
  idempotency, retry classification, and both local-first and remote-first W7
  action orderings.
- Added restart coverage for pending deliveries, explicit read-only versus
  single-use callback replay semantics, and callback-credential rotation for
  both Packet products.
- Added atomic dead-letter redrive with renewed bounded attempts/expiry, the
  original external idempotency key, a fresh scheduler job, an auditable
  digest-only recovery event/evidence entry, exact request replay, and
  fail-closed behavior after source-evidence compaction.
- Added opt-in live PacketChat and PacketPhone delivery probes. They remain
  conditionally skipped because no external endpoint configuration is present.
  The full gate passes 1,509 API tests plus 28 web tests, with 4 intentional API
  skips, 0 failures, and the unchanged 145-warning inherited lint baseline.

### 2026-07-28 - PacketPhone Worker controls (W10.3)

- Added encrypted `packetagent.packetphone-route/v1` configuration and an
  HTTPS-only PacketPhone transport that reloads exact immutable Worker
  bindings before resolving route secrets around the hardened network call.
- Added role-bounded approve, reject, pause, stop, and revoke controls with
  explicitly typed HS256 POST callbacks bound to the exact action, workspace,
  definition, deployment, run, attention, version, actor, role, route, source
  event, revision, nonce, JTI, and expiry.
- Routed valid callbacks exclusively through W7. Its atomic idempotent
  `WorkerControlCommand` now serves as the durable single-use consumption
  record and retains only digest-safe PacketPhone authorization metadata.
- Added all-five-action, role-narrowing, deterministic retry, strict callback,
  restart replay, stale/resolved/tamper/expiry/cross-binding, secret-rotation,
  non-persistence, and three-backend parity coverage. The W10.3 baseline passes
  1,506 API tests plus 28 web tests, with 2 intentional API skips and no
  failures. W10.4 certification was the next active loop.

### 2026-07-28 - Pause handoff and implementation reports

- Consolidated every remaining W10 and inherited R1-R8 task into
  `BACKLOG.md`, the single active implementation ledger, and made the Codex
  handoff resume directly at W10.3 there at that pause.
- Added a 15-page canonical Worker implementation report covering W1-W10.2,
  the runtime safety model, verification baseline, and exact pause state.
- Added a separate 9-page Packet-suite integration reality check that states
  which work exists only inside PacketAgent, what PacketADE and PacketChat
  still need in their own repositories, and why PacketPhone W10.3 was not yet
  implemented at that pause.
- Recorded the PacketAgent `origin` and `main` branch while retaining
  `taskloom-source` as a read-only historical source.

### 2026-07-28 - PacketChat Worker delivery (W10.2)

- Added `packetagent.packetchat-route/v1` encrypted route configuration and a
  pinned-network PacketChat transport that verifies immutable
  workspace/deployment/run/version/route bindings before resolving secrets.
- Added admin-only Worker credential list/upsert/remove routes whose responses
  contain metadata only, allowing self-hosted operators to configure the
  encrypted PacketChat route without exposing plaintext or encrypted fields.
- Added `packetagent.packetchat-worker-message/v1` cards with bounded
  state/reason/budget/checkpoint/evidence/action data, stable run threads, and
  one replaceable progress message per run.
- Added short-lived HS256 open/inspect callbacks bound to the exact Worker
  identity, version digest, route, issuer, audience, and expiry. Callback
  responses are no-store and return either the Worker workbench URL or W8's
  redacted operations detail.
- Added encrypted-vault, idempotency, secret non-persistence, tamper, expiry,
  cross-workspace, failure-classification, delegation, and callback-route
  contract tests. The W10.2 baseline passes 1,493 API tests plus 28 web tests,
  with 2 intentional API skips and no failures. W10.3 PacketPhone controls and W10.4 cross-product
  certification remain active, so the unified lifecycle is not yet a shipped
  claim.

### 2026-07-28 - Channel-neutral Worker notification outbox (W10.1)

- Added versioned attention, progress, and terminal notification envelopes
  bound to immutable Worker/version/run identity plus the exact source event,
  evidence ID, and event digest.
- Added durable outbox items with stable idempotency keys, attempt leases,
  bounded exponential retry, expiry, dead-letter outcomes, opaque route
  references, and allowlisted delivery metadata.
- Attention requests, progress checkpoints, and terminal outcomes now enqueue
  their matching delivery job atomically with the source journal/evidence
  write. The scheduler handles local PacketAgent delivery and leaves external
  PacketChat/PacketPhone adapters fail-closed for later loops.
- Pending outbox items pin their W8 source evidence. Terminal delivery records
  permit compaction only after a digest-bound retention tombstone preserves
  provenance.
- JSON, SQLite, and managed-Postgres parity plus retry, expiry, redaction,
  rollback, retention, and idempotent replay tests pass. W10.2 PacketChat
  delivery remains active, so the unified cross-product lifecycle is not yet a
  shipped claim.

### 2026-07-28 - PacketADE handoff gate (W9.5)

- Added a checked serialized PacketADE scenario covering local capability
  acceptance, activation input, v2 update, pause/resume, v1 rollback, revoke,
  and expected deployment events.
- Added an HTTP-level gate that validates and deploys the package, activates a
  version-pinned queued run, aborts the event connection, serializes the
  durable store, constructs fresh service/route instances, and reconnects the
  same receipt, deployment, run, acknowledgement, and evidence.
- The reconstructed client then updates, pauses, resumes, rolls back, and
  revokes through the canonical W2/W3/W7/W8/W9 boundaries without broadening
  local grants or losing the original run.
- Added a bounded live-network validation test that requires an explicit HTTPS
  (or loopback) endpoint, workspace, and PacketADE bearer credential; it stays
  skipped when those operator-controlled values are unavailable.
- W9's local gate passes. W10 PacketChat/PacketPhone notification and control
  routes remain active, so the unified cross-product lifecycle is not yet a
  shipped claim.

### 2026-07-28 - PacketADE reconnectable events (W9.4)

- Added versioned PacketADE deployment/run event projections over the W8
  journal for progress, approval, checkpoint, completion, failure, budget,
  pause, and revoke outcomes, with immutable Worker-version identity and
  linked evidence.
- Added stable opaque event IDs, cursor-paginated reads, bounded SSE with
  `Last-Event-ID`, heartbeat/close frames, explicit trace gaps, and recoverable
  `410` retention-window responses.
- Added explicit monotonic cursor advancement guarded by strong `If-Match`
  ETags and durable idempotent acknowledgement records. SSE delivery never
  mutates the acknowledgement.
- Added SQLite migration `0025`, secret-free workspace export, repository
  integrity checks, and JSON/SQLite/managed-Postgres parity.
- The W9.4 baseline covers 1,480 API tests (1,479 passed and 1 intentionally
  skipped) with zero lint errors.
- W9.5 remains the serialized disconnect/process-restart handoff gate, so the
  unified lifecycle is not yet a shipped claim.

### 2026-07-28 - Packet-product trust and deployment API (W9.2-W9.3)

- Added digest-only, workspace-bound PacketADE bearer credentials with fixed
  service actors, operation grants, expiry/revocation state, optional DSSE
  requirements, durable rate limiting, and token-safe audit records.
- Persisted pre-deployment package integrity/provenance/idempotency receipts
  and explicit local capability decisions that can only narrow the package
  upper bound.
- Added service-to-service validate, deploy, update, activate, inspect,
  list-runs, pause, resume, rollback, and revoke endpoints over the canonical
  lifecycle, activation, control, and observability services.
- Added atomic forward deployment rollouts and immutable receipt-to-deployment
  bindings. Updates and rollbacks preserve locally narrowed grants; W3 manual
  admission and W7 revocation retain their durable replay semantics.
- Added SQLite migrations `0023` and `0024`, secret-free workspace export, and
  JSON/SQLite/managed-Postgres parity coverage.
- The W9.3 baseline covers 1,476 API tests (1,475 passed and 1 intentionally
  skipped) plus 28 web tests with zero lint errors.
- Reconnectable PacketADE events and the final disconnect/restart handoff gate
  remain W9.4-W9.5 work, so the unified lifecycle is not yet a shipped claim.

### 2026-07-28 - WorkerPackage v1 contract (W9.1)

- Froze `packetagent.worker-package/v1` as a strict wire envelope mapping
  PacketADE provenance, Worker identity, complete W1 version content, artifact
  references, idempotency, and integrity metadata without workspace-assigned
  lifecycle IDs or secret values.
- Added deterministic canonical JSON subject bytes and mandatory SHA-256
  verification with property-order independence, finite/I-JSON scalar guards,
  exact UTF-8 encoding, and constant-time digest comparison.
- Added optional DSSE envelopes bound byte-for-byte to the same canonical
  subject plus a verifier seam for W9.2 trust policy; required or untrusted
  signature cases fail closed.
- Added checked valid-v1 and unsupported-v2 fixtures plus tamper,
  missing-bound, undeclared-field, Unicode, canonical-order, payload
  substitution, and signature-policy tests.
- The W9.1 baseline covers 1,466 API tests (1,465 passed and 1 intentionally
  skipped) plus 28 web tests with zero lint errors.
- W9.1 defines the contract only. Packet-product authentication, durable
  package receipts, deployment endpoints, and reconnectable PacketADE events
  remain W9.2-W9.5 work, so the unified lifecycle is not yet a shipped claim.

### 2026-07-28 - Worker answerability gate (W8.5)

- Closed W8 with one-read tests proving the operations detail answers Worker
  identity, objective/trigger, immutable version/deployment, hard-budget usage,
  provider cost, latest checkpoint, attention, evidence, artifacts, and
  outcome without client-side raw-table joins.
- Added source-order replay and JSON/SQLite/managed-Postgres parity coverage
  for the operations projection, plus stable filter- and tenant-bound
  attention cursor checks.
- Added explicit accessible semantics for Worker list/detail loading, error,
  empty, missing, and ready states, with automated web coverage and a manual
  screenshot/accessibility matrix.
- The W8.5 baseline covers 1,460 API tests (1,459 passed and 1 intentionally
  skipped) plus 28 web tests with zero lint errors.
- W8 is complete. The unified cross-product Worker lifecycle is not yet a
  shipped claim; W9 PacketADE handoff and W10 PacketChat/PacketPhone routes
  remain gated work.

### 2026-07-28 - Canonical Worker operations API and UI (W8.4)

- Added one workspace-scoped operations read model that joins Worker identity,
  deployment/version, live state, budget policy and usage, latest checkpoint,
  attention, deterministic rollups, evidence, artifacts, and control
  availability on the server.
- Added independently authorized health, run list/detail, attention, event,
  evidence, and artifact reads with stable filters and opaque cursors bound to
  their workspace and query.
- Added bounded SSE event connections with `Last-Event-ID` resume, explicit
  duration/event ceilings, heartbeat/close metadata, and the paginated event
  API as a polling fallback.
- Made `/runs` the canonical Worker operations surface with budget,
  checkpoint, attention, evidence timeline, artifacts, and controls; preserved
  inherited Agent activity at `/activity`.
- Added focused cursor, workspace-isolation, redaction, one-read detail, route
  authorization, and SSE reconnect coverage plus a signed-in browser pass for
  the list, navigation, empty, and error states.
- W8.5 remains the final answerability and accessibility gate; this change does
  not claim the unified Worker lifecycle is shipped.
- The W8.4 baseline covers 1,458 API tests (1,457 passed and 1 intentionally
  skipped) plus 25 web tests with zero lint errors.

### 2026-07-27 - Bounded Worker retention and redaction (W8.3)

- Added versioned, independently configurable retention windows for metadata,
  summaries, prompts, tool inputs/outputs, and artifact bytes.
- Redacted sensitive keys, structured credentials, and caller-supplied known
  secret values before journal persistence and again in observability read
  projections.
- Compacted only terminal-run inputs, outputs, checkpoint chains, and effect
  result bodies, preserving active-run recovery state and duplicate-effect
  receipt metadata.
- Added digest-only deletion events and rollup accounting that separates
  retention-explained source gaps from unexplained missing records.
- Added digest-checked artifact-deletion ports without interpreting or deleting
  arbitrary artifact paths.
- Registered bounded, workspace-scoped recurring cleanup jobs with read-only
  dry runs, item/time ceilings, category metrics, and explicit tenant matching.
- Proved repeat-run idempotency, active-run preservation, workspace isolation,
  API-boundary redaction, and JSON/SQLite/managed-Postgres parity.
- The W8.3 baseline covers 1,452 API tests (1,451 passed and 1 intentionally
  skipped) plus 25 web tests with zero lint errors.

### 2026-07-27 - Deterministic Worker observability rollups (W8.2)

- Added disposable cumulative rollups keyed by immutable Worker version,
  deployment, and run rather than persisting a second mutable source of truth.
- Aggregated correlated provider/tool calls, mutation effects, job and
  supervisor retries, queue duration, approvals, checkpoints, reported and
  rolling budgets, artifact bytes, run outcomes, and exit-predicate matches.
- Added stable source adapters for canonical Worker jobs, provider calls, and
  explicitly correlated activities without falsely joining inherited Agent
  traces or global scheduler snapshots.
- Added deduplicated typed gaps for evidence references whose retained source
  record is unavailable, while preserving journal-derived counts and safe
  provider usage.
- Journaled failed tool results and supervisor phase failures so failures,
  retry backoff, and unsuccessful calls remain visible to rebuilds.
- Proved order-independent replay, fresh-process rebuild, workspace isolation,
  missing-source behavior, and stable JSON/SQLite/managed-Postgres parity.
- The W8.2 baseline covers 1,448 API tests (1,447 passed and 1 intentionally
  skipped) plus 25 web tests with zero lint errors.

### 2026-07-27 - Worker event and evidence model (W8.1)

- Added digest-bound v2 Worker event envelopes with monotonic workspace,
  deployment, and run sequences; W3C trace context; durable provider, tool,
  effect, approval, checkpoint, and control correlations; and explicit
  redaction classifications.
- Routed lifecycle, activation, queue, supervisor, provider, tool, effect,
  approval, checkpoint, control, recovery, and terminal occurrences through a
  central journal that atomically pairs every new event with evidence.
- Added optional opaque raw-payload references plus artifact manifests bound to
  content digests, source evidence, materials, and generation provenance.
- Kept legacy v1 events readable without fabricating evidence and added ordered,
  workspace-scoped event, evidence, and artifact-manifest repository reads.
- Added migration `0022_worker_observability.sql`, dedicated evidence and
  artifact tables, event indexes, workspace export support, and
  JSON/SQLite/managed-Postgres parity coverage.
- The W8.1 baseline covers 1,444 API tests (1,443 passed and 1 intentionally
  skipped) plus 25 web tests with zero lint errors.

### 2026-07-27 - Worker restart and kill gate (W7.5)

- Added a fresh-process approval test that reconstructs runtime, attention, and
  control services from durable state, resumes the exact waiting action, and
  replays the approval callback without another nonce or grant.
- Exercised both approve-first/reject-second and reject-first/approve-second
  atomic orderings. Exactly one command applies and the resulting
  attention/run/grant graph remains consistent.
- Stopped a live Worker through the real durable control service at plan, act,
  evaluate, checkpoint, and decide. No runtime event or action occurs after
  the stop is observed.
- Exercised both activation-first/revoke-second and revoke-first/activation-
  second orderings. The deployment remains revoked, admitted work is
  terminalized and canceled, and all future activation fails.
- Reconstructed the independent operator routes using only a durable store and
  proved stop and revoke do not depend on Builder or PacketADE services.
- W7's gate now passes. The W7.5 baseline covers 1,438 API tests (1,437 passed
  and 1 intentionally skipped) plus 25 web tests with zero lint errors.

### 2026-07-27 - Independent Worker operator API (W7.4)

- Mounted a dedicated Worker operator route module beside the lifecycle API,
  independent of the Builder surface.
- Added concise workspace-scoped run and attention reads plus pause, resume,
  stop, deployment revoke, approve-once, approve-for-run, and reject
  operations backed by the atomic control service.
- Split Worker authorization into explicit inspect, run-control,
  deployment-control, and approval permissions. Viewers can inspect, members
  can control runs, and deployment revoke or approval requires an admin.
- Operator mutations require an allowlisted JSON body, positive expected
  revision, and bounded idempotency key. Durable command rejections return
  conflict state suitable for CLI clients.
- Operator projections omit run input/output, errors, traces, leases, request
  digests, nonce digests, compiled policy, and raw events while retaining a
  safe operation summary for approval decisions.
- Approval nonces appear only on the first applied response and carry
  `Cache-Control: no-store`; replay returns the durable grant without the raw
  nonce.
- The W7.4 baseline covers 1,427 API tests (1,426 passed and 1 intentionally
  skipped) plus 25 web tests with zero lint errors.

### 2026-07-27 - Supervisor approval attention (W7.3)

- Added an immutable Worker attention policy with bounded approval and
  escalation windows plus an explicit pause-or-reject expiration disposition.
- Approval-required tool operations now atomically persist their action cursor,
  pending attention request, notification references, deadline jobs, audit
  event, budget, and `waiting_for_approval` run state.
- Added scheduler-backed escalation and expiration processing with deduplicated
  requested/escalated delivery keys and fail-closed pause or
  `approval_expired` outcomes.
- Resume now requires an approved request from the latest checkpoint plus a
  matching version, deployment, compiled-policy digest, capability, operation,
  and unexpired grant.
- One-time grants are replay-safe only for the same action; run-scoped grants
  stay operation-bound. Approval evidence is rechecked immediately before the
  tool handler, including expiry, without persisting the raw nonce.
- Human attention rejection now terminalizes the bound run as
  `approval_rejected`, cancels execution work, and records the applied run
  revision atomically.
- The W7.3 baseline covers 1,420 API tests (1,419 passed and 1 intentionally
  skipped) plus 25 web tests with zero lint errors.

### 2026-07-27 - Atomic Worker control service (W7.2)

- Added one atomic service for pause, resume, stop, deployment revoke,
  approve-once, approve-for-run, and attention rejection, with an expected
  revision and idempotency key on every command.
- Pause now fences live execution while preserving the last checkpoint and
  remaining budget; resume queues the same run with a new runtime fence. Stop
  terminalizes one run, while revoke makes the deployment inadmissible and
  terminalizes all of its nonterminal runs.
- Persisted applied and rejected command outcomes plus audit events. Concurrent
  stale commands reject durably, exact retries replay without a second state
  transition or execution job, and transaction failures roll back the command,
  target, job, and event together.
- Added actor-, version-, capability-, operation-, scope-, and expiry-bound
  approvals. Raw approval nonces are returned only on first application and
  never stored or emitted.
- Added paused-job draining, supervisor control checks after fenced checkpoint
  conflicts, externally terminalized-run convergence, cross-workspace job
  isolation, and JSON/SQLite/managed-Postgres service parity coverage.
- The W7.2 baseline passes 1,409 API tests, 1 skipped API test, and 25 web tests
  with zero lint errors and 145 inherited warnings.

### 2026-07-27 - Durable Worker control records (W7.1)

- Added versioned attention-request, approval-grant, control-command, and
  notification-delivery records with status-specific invariants and immutable
  workspace/definition/deployment/run/version-digest bindings.
- Bound approvals to capability and normalized-operation digests, scope,
  actor, expiry, and a nonce digest; one-time consumption, revocation, and
  expiration are represented durably without storing a bearer nonce.
- Added unique attention request keys, approval nonce digests, control
  idempotency keys, and notification delivery keys plus graph validation
  across resolved attention, applied approval command, and active grant.
- Persisted and workspace-exported the control collections across JSON,
  SQLite, and managed Postgres, with legacy-store normalization and backend
  parity coverage.
- The W7.1 baseline passes 1,397 API tests, 1 skipped API test, and 25 web tests
  with zero lint errors and 145 inherited warnings.

### 2026-07-27 - Worker permission bypass gate (W6.5)

- Guarded every production registry handler with a one-shot, tool-bound permit
  issued only by `executeTool` after compiled-policy approval; direct registry
  calls and nested permit reuse now fail closed for Worker contexts.
- Exported the production tool catalog for exhaustive gate coverage while
  preserving the existing default-registry bootstrap.
- Added catalog-wide executor/direct-access tests plus adversarial stale-policy,
  denial-ordering, redirect, alternate-address, DNS-rebinding,
  linked/case-aliased path, hostile command-argument, credential-mismatch, and
  concurrent rolling-budget coverage.
- The W6.5 baseline passes 1,390 API tests, 1 skipped API test, and 25 web tests
  with zero lint errors and 145 inherited warnings.

### 2026-07-27 - Atomic Worker rolling budgets (W6.4)

- Added durable workspace/deployment rolling windows for provider cost and externally billable HTTP, Slack, and GitHub actions, with finite compatibility defaults for older Worker versions.
- Provider calls atomically reserve their maximum remaining per-run cost before execution, settle actual usage, and terminate without calling the provider when workspace or deployment capacity is unavailable.
- Authorized billable tools reserve after policy approval but before effect preparation or I/O; policy denials create no budget hold.
- Added fence- and retry-bound deterministic reservation keys, idempotent settle/release behavior, and recovery reconciliation that releases terminal, expired-lease, or replaced-lease holds without double credit.
- Persisted and exported redacted budget reservation records across JSON, SQLite, and managed Postgres.
- Added concurrency, independent workspace/deployment ceiling, worst-case provider, billable-action ordering, rolling exhaustion, window expiry, idempotency, recovery, validation, and backend parity coverage; the W6.4 baseline passes 1,384 API tests, 1 skipped API test, and 25 web tests.

### 2026-07-27 - Worker credential, network, and process hardening (W6.3)

- Added encrypted workspace-scoped Worker credentials for API keys, bearer tokens, webhook URLs, SMTP configuration, and opaque values. Public service and workspace-export results contain metadata only.
- Bound credential resolution to immutable-version `vault:` references and credential kinds; allowed HTTP, Slack, and GitHub handlers resolve secrets only after immediate policy approval and directly before hardened I/O.
- Added a Worker network client that permits only HTTP(S), validates every A/AAAA result against special/private ranges, pins the selected address through connection, verifies the connected address, bounds responses, and denies redirects.
- Routed Worker HTTP tools through the hardened client; browser, SMTP, and SQL Worker paths now fail closed until equivalent hardened drivers exist.
- Routed Worker command tools through a Docker-only no-network port. Docker runs non-root with CPU/memory/PID bounds, a read-only root, all capabilities dropped, no-new-privileges, shell-quoted arguments, and a scrubbed Docker CLI environment.
- Added credential export/isolation, policy-before-resolution, SSRF/DNS-rebinding, redirect, Docker/native-fallback, environment, and JSON/SQLite/managed-Postgres parity coverage; the W6.3 baseline passes 1,372 API tests and 25 web tests.

### 2026-07-27 - Immediate Worker tool policy enforcement (W6.2)

- Extended Worker tool context with pinned run, deployment, version, capability, budget, effect, and actor data.
- Added normalized authorization operations for every production-registered tool, covering HTTP method/URL, GitHub verb/resource, SQL mode/database, workspace and browser targets, Slack destinations, email recipients, executable names, and working-directory paths.
- Added a fail-closed policy evaluator that verifies the compiled-policy schema, version digest, policy digest, approval requirement, verb, effect, capability, and every concrete resource.
- Worker adapters now preflight policy before mutation receipt preparation, while `executeTool` independently re-authorizes and persists a redacted allow/deny decision immediately before the handler.
- Default tool registration now rejects missing authorization descriptors and tests assert exact parity between the production catalog and the Worker capability schema.
- Added executor, adapter, supervisor, normalization, stale/tampered-policy, undeclared-resource, event-redaction, and production-catalog coverage; the W6.2 baseline passes 1,360 API tests and 25 web tests.

### 2026-07-27 - Compiled Worker capability policy (W6.1)

- Added a pure capability compiler that expands validated Worker requests into deterministic tool, verb, resource, effect, and approval tuples tied to the immutable version content digest.
- Added the built-in Worker tool verb/effect catalog plus canonical HTTPS, opaque-resource, command, and absolute-filesystem normalization.
- Version validation now rejects unknown tools/verbs, effect mismatches, broad or ambiguous wildcards, non-HTTP network schemes, URL credentials/query/fragment data, relative filesystem escapes, raw credential values, and contradictory overlaps.
- Deployments now persist normalized capability grants and a compiled policy digest. Explicit grants may remove capabilities, narrow verbs/resources, or require more approval, but cannot exceed their version's requested upper bound.
- Added compiled-policy integrity checks across lifecycle transitions, rollback, repository reload, routes, exports, and JSON/SQLite/managed-Postgres parity.
- Added bounded retries for transient Windows `EPERM`, `EACCES`, and `EBUSY` errors while atomically replacing the JSON store, eliminating a reproduced full-suite persistence race.

### 2026-07-27 - Checkpoint, recovery, and side-effect safety (W5)

- Upgraded phase cursors to immutable digest-chained checkpoints containing redacted supervisor memory, completed actions, pending approvals, artifacts, effect receipt IDs, trace context, and exact remaining budgets.
- Added explicit read-only, idempotent, reconcilable, and non-replayable tool-effect classifications plus deterministic action keys and prepared/completed redacted receipts.
- Added safe completed-result replay, idempotent retries, reconciliation hooks, and fail-closed quarantine when an external mutation cannot be proven absent or completed.
- Added scheduler startup and periodic recovery for expired Worker leases, exact action-cursor resume, corrupt-chain/version/budget detection, and idempotent execution-job requeue.
- Added the forward-only `0021_worker_effect_receipts.sql` migration, workspace export support, managed-Postgres comparison coverage, and JSON/SQLite/managed-Postgres recovery parity.
- Added crash, restart, replay, reconciliation, fencing, scheduler-restart, checkpoint-chain, and quarantine tests; the W5 gate passes with 1,348 API tests and 25 web tests.

### 2026-07-27 - Bounded autonomous supervisor (W4)

- Added narrow Worker provider, tool, clock, checkpoint, event, lease, cancellation, and run ports plus adapters for the existing provider router, cost ledger, tool registry, and executor.
- Added the pure plan-act-evaluate-checkpoint-decide reducer; only it selects completed, failed, budget-exhausted, cancelled, or quarantined terminal outcomes from declared exit predicates and explicit evidence.
- Added monotonic elapsed-time, iteration, provider-cost, consecutive-failure, retry/backoff, and pre-execution tool-call enforcement around every awaited provider/tool boundary.
- Replaced `worker.run` deferral with canonical execution, optimistic run revisions, monotonic lease fencing, cursor checkpoints, lifecycle events, revocation/cancellation checks, and scheduler-shutdown release.
- Added adversarial coverage for endless tools, hung/failed providers, invalid evaluations, cost exhaustion, cancellation at every phase, ignored abort signals, lease theft, stale revisions, expired-lease takeover, and JSON/SQLite/managed-Postgres parity.

### 2026-07-27 - Trigger and activation envelope (W3)

- Added a versioned Worker activation envelope, durable deduplication inbox, and `0020_worker_activations.sql` migration across JSON, SQLite, and managed Postgres.
- Added atomic intake that validates the active deployment, enabled trigger, and Worker input schema before committing one version-pinned queued run, audit event, and execution job.
- Added encrypted, expiry-bound payload references for large or sensitive inputs; workspace exports include reference metadata without ciphertext.
- Routed manual requests, timezone-aware cron occurrences, opaque Worker webhooks, durable alerts, and queue deliveries through the common intake service while preserving legacy Agent triggers.
- Added W3C trace propagation, exact-replay receipts, changed-content delivery conflicts, JSON transaction rollback isolation, bounded scheduler deferral before W4, crash injection, and multi-backend concurrency coverage.

### 2026-07-27 - Worker persistence, versioning, and activation (W2)

- Added durable Worker definitions, versions, deployments, runs, checkpoints, rollout links, command receipts, and lifecycle events to every supported store.
- Added the forward-only `0019_worker_lifecycle.sql` migration with workspace-scoped keys, immutable version identity, deployment revisions, one-active-deployment enforcement, idempotency uniqueness, event sequencing, foreign keys, and lifecycle indexes.
- Added atomic lifecycle services and private RBAC-protected routes for definition/version creation, draft updates, validation, deployment, activation, pause/resume, retirement, and rollback to an older validated version.
- Bound idempotent replay to workspace, operation, target, actor, and canonical request content; stale digests and revisions return stable conflicts.
- Added JSON, SQLite, and managed-Postgres parity coverage for concurrent activation, rollback, reload, export, and JSON-to-SQLite backfill.

### 2026-07-27 - Canonical Worker contract (W1)

- Added versioned, storage-neutral schemas and runtime validators for `WorkerDefinition`, `WorkerVersion`, `WorkerDeployment`, `WorkerTrigger`, `WorkerPolicy`, `WorkerRun`, and `WorkerCheckpoint`.
- Added required time, iteration, provider-cost, failure, tool-call, retry, permission, trigger, exit-predicate, and provenance validation.
- Added lifecycle and terminal-state transition guards, validated/deployment-bound version immutability, deployment version pinning, and optimistic deployment revision checks.
- Added PacketADE source provenance fields for flight, project, conversation, repository, and revision.
- Added deterministic draft projections over existing Agent and workspace workflow records without changing their APIs or exposing webhook tokens.
- Added 31 focused contract tests and recorded the research, decisions, implementation loops, and W2 boundary in `dev/worker-contract-plan.md`.

### 2026-07-27 - PacketAgent foundation rename

- Created PacketAgent from the complete TaskLoom Git history while preserving the original checkout.
- Renamed product, package, environment, storage, UI, Docker, documentation, and source identifiers to PacketAgent.
- Added temporary read compatibility for legacy `TASKLOOM_*` environment values.
- Added non-destructive first-boot copying from legacy default TaskLoom JSON and SQLite files to PacketAgent defaults.
- Repositioned the existing builder, scheduler, agent runtime, tools, vault, storage, and operations platform as the foundation for a bounded autonomous-worker runtime.
- Added the Worker implementation loops and the planned PacketADE-to-PacketAgent deployment contract.
- Added an authoritative Codex project handoff with repository state, verified gates, implementation truth, and the initial W1 resume point.
- Marked the former Phase 3, playbook sprint, handoff, and repository-review documents as historical so they cannot override the current roadmap.
- Corrected active setup and product documentation to reflect the shipped bounded code-repair loop, per-app SQLite runtime, outbound agent tools, missing PacketAgent remote, and unimplemented durable Worker lifecycle.

### 2026-05-17 - File-tree codegen filled out: iteration parity, chunked planning, vite-build validation, inline error UX, default-on

This entry covers the second round of Track B work. The opt-in skeleton from the previous round is filled out: file-tree codegen now runs by default when a BYOK provider key is configured, iteration mirrors the new path, plans for larger apps are batched across multiple write rounds, the validator runs a real `vite build` alongside `tsc`, and validation errors surface inline in the Builder chat thread.

#### Track B round 2

- **Default path flipped.** File-tree codegen now runs by default when a BYOK provider key is present. No env flag required. The structured-tool / template path remains the fallback when no key is configured or the orchestrator returns null.
- **New opt-out `PACKETAGENT_LEGACY_TEMPLATES=1`.** Forces the legacy template path, skipping the file-tree codegen orchestrator entirely. The previous opt-in flag `PACKETAGENT_FILETREE_CODEGEN=1` is preserved as a no-op for installs that already set it.
- **Iteration parity.** `src/app-iteration-service.ts` gained a file-tree iteration path. When the draft being iterated on was generated via the file-tree path (`source === "llm-filetree"`) and the file tree is available, iteration re-runs the orchestrator on an iteration-shaped prompt and computes a diff (added / modified / deleted) against the prior tree. Falls back to the regex iteration pipeline when the draft is template-shaped.
- **Chunked planning for large apps.** When the plan has more than 10 files, the orchestrator now batches `write_file` calls across multiple LLM rounds (chunks of up to 8 files each), with an early-stop when a chunk returns nothing. Small plans (10 files or fewer) keep the existing single-write-phase behaviour.
- **Vite-build validation.** The validator now runs `vite build` after `tsc --noEmit`, with phase-tagged errors (`phase: "typecheck" | "build"`). When tsc fails, the build step is skipped. Both phases are gated on the existing `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1` env.
- **Inline error UX.** When the file-tree path returns validation errors, the Builder chat thread now renders them inline as a warn-toned card with a "Fix these errors" button. The button triggers an iteration with the errors as the prompt.

#### Known gaps

- Multi-round auto-fix on broken TypeScript is not implemented. The validator runs once; errors surface to the user; iteration is the user's choice via the new "Fix these errors" button.
- Iteration on legacy-template drafts still uses the regex pipeline - only file-tree drafts use the new iteration path.
- The new vite-build step is still gated on `PACKETAGENT_SANDBOX_SMOKE_ENABLED=1`; with the gate off, the validator returns a skipped result.

### 2026-05-17 - Six-provider BYOK, remote-pointable local LLM, cleanup

This entry covers the two rounds of provider work that landed after the builder-first refactor: the builder draft + iteration paths are now fully routed through `ProviderRouter` and accept six providers, and the local-LLM provider became remote-pointable so a separate GPU box can serve the workbench laptop.

#### Providers

- **Gemini adapter** (`src/providers/gemini.ts`). Speaks Google's OpenAI-compatible endpoint. Registered only when `GOOGLE_API_KEY` or `GEMINI_API_KEY` is set. Preset picks: `gemini-2.5-flash` (fast / cheap), `gemini-2.5-pro` (smart).
- **OpenRouter adapter** (`src/providers/openrouter.ts`). Marketplace access to Anthropic / Google / Mistral / DeepSeek / etc. via a single OpenAI-compatible endpoint. Registered only when `OPENROUTER_API_KEY` is set. First on the default `cheap` priority walk.
- **`ProviderRouter` now routes all six providers** for both builder and agent paths: Anthropic, OpenAI, Gemini, OpenRouter, MiniMax, and the generic local-LLM provider. `generateAppDraftViaLLM` and `applyAppIterationViaLLM` no longer hard-code `AnthropicProvider`.
- **Preset resolver** (`src/providers/preset-resolver.ts`). Maps the four Builder presets (`fast`, `smart`, `cheap`, `local`) to a concrete `(provider, model)` pair via a per-preset priority walk. The `local` preset is strict: only routes to local providers, or returns null.
- **`PACKETAGENT_PROVIDER_PRIORITY` env override**. Comma-separated provider list replaces the default walk for every non-`local` preset (e.g. `PACKETAGENT_PROVIDER_PRIORITY=ollama,openrouter,anthropic`). First registered provider with a configured key wins.
- **Builder UI surfaces the resolved provider+model** on each preset chip, so operators can see which key actually drives `fast` vs `smart` vs `cheap` without poking at the server.
- **New endpoint `GET /api/app/builder/providers/status`**. Returns the resolved preset map, the list of providers with credentials, and the active priority override string. Used by the chip UI and useful for ops verification. No secrets in the response.

#### Local LLM

- **Remote-pointable**. The local-LLM provider can now talk to any OpenAI-compatible (or Ollama-native) endpoint on `localhost` or on a separate machine on your LAN - vLLM, LM Studio, llama.cpp's OpenAI-compat server, or remote Ollama. Local is **not** the default for hosted presets; Anthropic stays the default unless you pick `local` or set the priority override.
- **New env var `LOCAL_LLM_BASE_URL`**. Takes precedence over `OLLAMA_BASE_URL`. Documents intent for non-Ollama servers.
- **New env var `LOCAL_LLM_API_FORMAT`** (`ollama` | `openai`, default `ollama`). Switches between native Ollama `/api/chat` and OpenAI-compatible `/v1/chat/completions`. Set to `openai` for vLLM, LM Studio, and llama.cpp.
- **New env var `LOCAL_LLM_MODEL`**. Overrides the per-call model name; required for vLLM / llama.cpp setups where the server only loads one specific model and matches names strictly.
- **`OLLAMA_BASE_URL`** is honored as a legacy synonym when `LOCAL_LLM_BASE_URL` is unset.

#### Cleanup

- Workflows sub-tabs distinguished from the AdminPage outer tabs - fixes a UI collision where the Workflows admin pane's internal tabs were being styled by the same active-state rules as the top-level Admin nav.
- Windows-incompatible sandbox test cleanly skipped (rather than failing the suite) on platforms without a POSIX shell.
- Dead code removed from `builder.tsx` - the unused `ChatBubble` component and its imports.
- `tmp/` Playwright artifacts no longer tracked; added to `.gitignore`.

#### Docs

- README reframed: opener and "How it compares" now describe six-provider BYOK and remote-pointable local LLM. "Known limits" no longer says the builder is Anthropic-only - that gap is closed.
- `docs/SELF_HOST.md` gained per-provider subsections for all six providers, five concrete local-LLM recipes (Ollama / remote Ollama / vLLM / LM Studio / llama.cpp), a "Provider precedence and override" section explaining `PACKETAGENT_PROVIDER_PRIORITY`, and a `curl` example for `/api/app/builder/providers/status`.
- `BACKLOG.md` moved Gemini, OpenRouter, remote-pointable local LLM, and the preset -> provider+model resolver from "Still planned" into "Done in this pass".

### 2026-05-17 - Builder-first refactor, admin consolidation, LLM wire-up

This entry covers the work that landed since the prior changelog snapshot: the workbench was reshaped around a full-bleed Builder, the operator surfaces collapsed under a single Admin tab, the Builder draft + iteration paths got their first real LLM wire-up (Anthropic), and the Fork B (self-host first) positioning was made explicit in the docs.

#### Builder UX

- `/builder` lifted out of the workbench Shell into its own full-bleed route with a dedicated `BuilderLayout`. Topbar no longer leaks into the builder.
- Builder empty state redesigned: Direction A composer + four starter chips, matching the twin.so / Lovable shape.
- Chat thread + per-turn streaming prose, with click-to-edit default-on and per-message revert back to the prior checkpoint.
- App-preview view replaced the workbench Topbar with a minimal header.
- Sentence case copy across the workbench; the uppercase kicker / eyebrow pattern is gone. Raw IDs hidden behind a Details disclosure. Softened CI / CD vocabulary where it leaked into user-facing copy.

#### Admin consolidation + sidebar

- New `/admin/:tab` page consolidates sixteen previously top-level operator surfaces: Roles, SSO, Secrets, Rate limits, Webhooks, Releases, Storage, Backups, Notifications, Operations, Integrations, Activation, Sandbox, Workflows, Billing, Alerts.
- All sixteen views had their page-level chrome stripped so they render correctly inside the tabbed Admin container.
- Back-compat redirects from the sixteen individual admin paths to `/admin/:tab` so existing bookmarks and links keep working.
- Sidebar collapsed from a long secondary nav to four items: Build, Projects, Runs, Admin.

#### LLM wire-up (Anthropic, Fork B)

- `generateAppDraftViaLLM` now calls `AnthropicProvider` for the initial app draft. Falls back to deterministic template-only generation when no key is set - documented explicitly, not silent.
- `applyAppIterationViaLLM` calls `AnthropicProvider` for scoped iteration and emits a real LLM prose stream over SSE, not a synthetic placeholder.
- Multi-provider routing for the builder draft + iteration paths is _not_ yet wired through `ProviderRouter` - only Anthropic is supported today at the builder. Agent runs continue to route through the full provider router (Anthropic / OpenAI / MiniMax / Ollama).

#### Generated apps

- sql.js persistence in generated apps with realistic seed data, typed form controls, and the PacketAgent eyebrow removed. **Known issue**: sql.js loads from a jsdelivr CDN, so generated apps phone home on first load. Per-app server-side SQLite is scoped under Phase 3 Track C.

#### Fork B positioning + docs

- Added `CLOUD.md`: a deferred-features inventory of hosted-only capabilities (free public subdomains, hosted browser-agent farm, App Store submission, hosted OAuth proxy, cross-tenant memory, shareable conversation URLs, vendor-managed credit meter) and what a hypothetical PacketAgent Cloud product would need to ship them.
- Reworked `docs/SELF_HOST.md` as the canonical setup guide: prerequisites, 5-minute quick start, BYO-LLM-key configuration, deploy-your-generated-app section, troubleshooting.
- Added `docs/PHASE3_SCOPE.md` v2 scoping the next chunk: multi-provider BYOK, file-tree codegen, real per-app runtime, six new agent tools, sandbox + farm work, and cross-cutting security hardening. 29-39 focused days, 6-9 calendar weeks for a solo engineer at ~60% focused time.
- README reframed to lead with the Fork B story: self-host first, multi-provider BYOK as the aim, honest about today's Anthropic-only builder and the sql.js CDN.
- Fixed five Fork B blockers caught in peer review (positioning + doc drift); Phase 1 UX debt cleanup (back chevron, kicker leftover, dead code, name dedup); leftover stash conflict marker fix.

### Earlier work (carried forward to this release)

#### Added

- Builder-first generated app runtime: prompt-to-app writes a real React/Vite source workspace to `data/generated-apps/<workspace>/<app>/workspace`.
- Generated app preview route at `/api/app/generated-apps/:appId/preview`, including nested source and asset serving from the generated workspace.
- Generated source manifest with file hashes, byte counts, workspace path, app slug, checkpoint ID, and source file summaries.
- Source-diff iteration flow that compares previous and candidate generated files before applying scoped app changes.
- Rollback support that restores checkpoint source artifacts instead of regenerating unrelated source metadata.
- Local publish handoff that materializes generated bundles, runtime config, artifact manifests, and PacketAgent-served preview URLs.
- Builder UI support for generated source file summaries, workspace metadata, publish handoff copy, and clearer preview status.
- OSS launch basics: MIT license, security policy, `.env.example`, Dockerfile, and Docker Compose starter.
- Production startup hardening for security-sensitive settings and clearer local/development defaults.

#### Changed

- Builder copy now distinguishes saved local previews from public deployments.
- Generated runtime output and publish exports are ignored by git to keep local build artifacts out of commits.

#### Fixed

- Provider/tool readiness now fails loudly for missing required setup instead of implying a real run happened.
- Agent dry-run paths are labelled explicitly.
- Publish validation now blocks missing generated bundle/workspace artifacts.
- Generated preview routes resolve actual app IDs, slugs, checkpoints, and nested files instead of relying on placeholder preview paths.

## [0.1.0] - In development

Initial public development line for the PacketAgent self-hosted app and agent workbench.

### Included

- Prompt-to-agent and prompt-to-app builder flows.
- App drafts, checkpoints, scoped iteration, local preview, smoke checks, and publish handoff.
- Agent templates, runs, transcripts, tool-call timeline, jobs, schedules, webhooks, secrets, audit, RBAC, and sandbox surfaces.
- JSON store for contributor flow, SQLite for single-node installs, and managed Postgres support behind explicit startup gates.
- React workbench, Hono API, and Node 22 runtime.
