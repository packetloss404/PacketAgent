# R5 sandbox, egress, and preview isolation

This is the research and implementation evidence for R5. `BACKLOG.md` remains
the only task ledger.

## R5.1 decision: generated validation is mandatory

Before R5.1, both file-tree validation and Builder smoke were gated by
`PACKETAGENT_SANDBOX_SMOKE_ENABLED=1`. The default path returned successful
`source: "skipped"` results, while the enabled path handed a host directory and
host-resolved TypeScript/Vite binaries to a container that mounted neither and
did not contain the toolchain. Builder smoke then ran deterministic
`node -e ... ok:true` probes rather than generated source.

R5.1 replaces that contract:

- `validateFileTree` has only `source: "real" | "blocked"` and required
  validation is the default.
- A local validator image tag is derived from the validator Dockerfile and
  `package-lock.json`. Image inspection/build is bounded and the Docker CLI
  inherits only operational Docker/path/temp variables.
- Generated input is mounted read-only at `/input`, copied into `/tmp/work`,
  and never executed from the host mount.
- The container runs real TypeScript and Vite from the trusted image, has
  `--network none`, a read-only root, ephemeral `/tmp`, a non-root user,
  dropped capabilities, `no-new-privileges`, and CPU/memory/PID/timeout bounds
  inherited from the Docker sandbox driver.
- Vite uses its module-runner config loader so it does not try to write bundled
  config under the read-only dependency tree.
- Builder draft/change/refresh smoke validates the concrete generated runtime
  artifact. Infrastructure failure is a blocked failure, not fallback success.
- LLM authoring stops with `validation-blocked`; infrastructure failure does
  not trigger model repair attempts.
- The public sandbox API cannot select internal validator images or host
  mounts; only the trusted service call supplies them.

Docker documents that the `none` network driver completely isolates a
container from the host and other containers:
<https://docs.docker.com/engine/network/drivers/none/>.
The `docker run` reference defines read-only filesystems, tmpfs mounts,
capability removal, PID, CPU, and memory controls:
<https://docs.docker.com/reference/cli/docker/container/run/>.
Docker's default seccomp profile is an allowlist and Docker recommends leaving
it enabled:
<https://docs.docker.com/engine/security/seccomp/>.
The broader daemon/container security model is documented at
<https://docs.docker.com/engine/security/>.

## R5.1 proof

The deterministic unit/route coverage proves:

- required validation runs without an environment opt-in;
- missing/spawn-failed isolation produces `ok: false`, `source: "blocked"`;
- TypeScript failure skips Vite and real phase failures are preserved;
- blocked validation stops LLM repair and marks validation progress failed;
- the Docker invocation includes network, privilege, filesystem, resource,
  environment, trusted-image, and read-only-input arguments;
- Builder apply reports blocked validation instead of a successful fallback.

The uninjected command is:

```bash
npm run verify:codegen-sandbox
```

It builds or reuses the addressed validator image, mounts a representative
React/Vite source tree, and must return `source: "real"` with both phases
`passed`. On 2026-07-29 it passed in Docker Desktop after the first image build;
the warm verification completed in 8.5 seconds. The focused codegen/sandbox
suite passed 62/62 tests. The R5.1 closeout also passed typecheck, zero-warning
lint, formatting, the production web build, 32/32 web tests, and the complete
1,583-test API suite (1,580 passed with three intentional live
interoperability skips).

## R5.2 decision: no non-Docker untrusted fallback

The R5.2 inventory found no active `node:vm` import or execution path in
production source. The only non-Docker executor was the native driver, an
explicitly opted-in shell process with host filesystem, process, and network
authority.

The historical proposal suggested a Deno subprocess as the non-Docker
fallback. Current primary-source guidance does not support making that claim:

- Node says directly that
  [`node:vm` is not a security mechanism and must not run untrusted code](https://nodejs.org/api/vm.html).
- Deno denies filesystem, network, environment, subprocess, and other I/O by
  default, and supports scoped permission flags, but its static initial module
  graph has permission exceptions.
- Deno warns that `--allow-run` and FFI effectively bypass its sandbox, and its
  own
  [untrusted-code guidance](https://docs.deno.com/runtime/fundamentals/security/#executing-untrusted-code)
  recommends layered OS sandboxing such as cgroups/seccomp plus a VM or
  microVM.
- The detailed
  [Deno permissions reference](https://docs.deno.com/runtime/reference/permissions/)
  also notes module-cache/storage behavior and subprocess privilege
  independence that a production boundary must account for.

PacketAgent therefore defines the supported fallback as **none**: Docker is
required for all untrusted, generated, and autonomous command execution. This
is a fail-closed availability tradeoff, not an unfinished implicit fallback.
A future additional driver would need its own OS/VM isolation and the complete
R5 resource/network gate before it could change that statement.

The retained native driver is now a separate trusted-host diagnostic path:

- `startExec` always refuses native before the driver starts.
- `startTrustedHostExec` makes the exceptional call explicit and still depends
  on the existing operator opt-in.
- The REST route requires owner/admin authority before calling that path.
- `runSmokeBatch`, generated validation, and canonical Workers use the
  untrusted path and cannot fall through.
- Status returns `executionClass: "trusted-host-only"` and
  `untrustedCodeSupported: false`; the workbench labels it and disables command
  entry for non-admin roles.
- ESLint rejects `node:vm`/`vm` imports in production source, and a repository
  inventory test also catches dynamic-import syntax.

The R5.2 closeout passed typecheck, zero-warning lint, formatting, the
production web build, 32/32 web tests, 25/25 focused sandbox/route/Worker
tests, the uninjected real Docker validator, and the complete 1,586-test API
suite (1,583 passed with three intentional live interoperability skips).

## R5.3 decision: one effective boundary policy

Every sandbox entry point now resolves the same policy before driver start:

- commands are limited to 32 KiB and stdin to 64 KiB;
- client timeouts cannot exceed the operator maximum;
- Docker working directories must remain under `/workspace` or `/tmp`;
- explicit environments are limited by entry/name/value/total byte counts,
  reject secret-like and runtime-control names, and never inherit the host
  environment;
- Docker always selects `network=none`, a read-only root, and bounded writable
  `/tmp`; and
- CPU, memory, PID, tmpfs, and wall-clock limits are clamped to safe operator
  ranges and passed as concrete driver inputs.

The resulting record distinguishes the legacy `cpuLimitMs` compatibility
field from the actual wall-clock limit and records CPU, memory, PID, tmpfs,
network, filesystem, and environment policy explicitly. Accepted environment
names remain useful for audit, but all stored values are `[redacted]`.
SQLite migration `0027_sandbox_execution_policy.sql` keeps the persisted
record equivalent to the JSON adapter.

The Docker driver independently rejects missing or out-of-range policy input.
It applies `--network=none`, `--ipc=none`, equal memory and swap bounds,
CPU/PID limits, `nproc` and `nofile` ulimits, a read-only root, bounded
`nosuid,nodev` tmpfs, non-root identity, all-capability removal, and
`no-new-privileges`. Trusted internal mounts must be read-only and target the
`/input` subtree. Timeout/cancel cleanup has its own five-second Docker CLI
deadline.

## R5.3 proof

Unit, route, and storage coverage exercises policy clamping, forbidden
environment variables, path escape, over-limit timeouts, driver-side policy
rejection, JSON/SQLite record parity, and byte-accurate multibyte output
truncation.

The uninjected command is:

```bash
npm run verify:sandbox-policy
```

It runs real Docker jobs through `SandboxService`. The first proves the
read-only root rejects a write, bounded `/tmp` accepts a write, an explicit
environment value reaches the process but persists only as `[redacted]`, and a
direct external-IP connection fails. The second proves a one-second
wall-clock deadline produces terminal `timeout` state. Both records must expose
the expected effective policy for the verifier to pass.

The R5.3 closeout passed typecheck, zero-warning lint, formatting, the
production web build, 32/32 web tests, 51/51 focused sandbox/route/Worker
tests, both uninjected real Docker verifiers, and the complete 1,598-test API
suite (1,595 passed with three intentional live interoperability skips).

## R5.4 decision: broker inputs, never bridge untrusted code

Docker documents that the `none` network driver leaves only loopback and
isolates a container from the host and other containers:
<https://docs.docker.com/engine/network/drivers/none/>. Replacing it with a
normal bridge after validating a URL would not enforce an allowlist against the
untrusted process; the process could open a different socket after admission.

OWASP's SSRF guidance calls for strict destination allowlists, disabling
redirect following, resolving and validating every IPv4/IPv6 answer, and
accounting for DNS pinning:
<https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html>.
Node's DNS API explicitly returns every address with `all: true`, and its
socket APIs allow a caller-supplied lookup function:
<https://nodejs.org/api/dns.html#dnslookuphostname-options-callback>.
Those are already the mechanics of the W6 `WorkerNetworkPort`.

R5.4 therefore adds declared egress as brokered read-only input:

- default policy remains deny-all;
- an operator may configure at most 32 exact HTTP(S) origins, without
  wildcard, path, query, fragment, or credentials;
- each execution may declare at most eight unique, path-safe IDs and GET URLs
  on those origins;
- PacketAgent fetches them through the existing W6 client, which validates all
  A/AAAA answers and the final connected address, pins the connection, blocks
  local/special/alternate IP forms, and refuses redirects;
- each response has a bounded deadline and byte cap, with a 512 KiB aggregate
  limit;
- successful bodies plus `_manifest.json` are written to a transient directory
  and bind-mounted read-only at `/input/egress`; and
- Docker still receives `networkPolicy=none`, so untrusted code has no direct
  network route.

The record uses `networkPolicy: "brokered-prefetch"` and persists only a
query-redacted target, exact origin, GET method, response status/content type,
byte length, SHA-256 digest, connected address, and container mount path.
Response bodies, host temp paths, and query values never enter the record.
Failed network work terminalizes the already-created audit record before
Docker starts. Cleanup runs after driver failure, completion, timeout, or
cancel.

## R5.4 proof

Focused tests prove default denial, exact-origin matching, safe unique IDs,
alternate-IP rejection, mixed public/private A/AAAA rejection, redirect
denial, connected-address mismatch, response and aggregate bounds,
query-safe/digest-bound receipts, transient cleanup, route parsing,
JSON/SQLite parity, and that Docker always receives `networkPolicy=none`.

The real-container verification command is:

```bash
npm run verify:sandbox-egress
```

It injects one deterministic host-broker response and executes a real
networkless container. The command must read the mounted body and manifest,
fail to mutate the read-only body, and fail a direct external-IP connection.
The verifier also requires exactly one broker call,
`networkPolicy: "brokered-prefetch"`, a materialized digest receipt, and
absence of the transient query value from the serialized record.

The R5.4 closeout passed typecheck, zero-warning lint, formatting, the
production web build, 32/32 web tests, 66/66 focused sandbox/network/route
tests, the real Docker verifier, and the complete 1,608-test API suite (1,605
passed with three intentional live interoperability skips).

## R5.5 decision: generated code gets its own browser authority

The prior preview route was authenticated by the normal PacketAgent session
cookie and served under `/api/app/generated-apps/:appId/preview` on the
workbench origin. The iframe included `allow-same-origin`, and click-to-edit
read `contentDocument` directly. A share token traveled in `?token=`, so the
credential could reach application and reverse-proxy access logs.

Changing only the port is not an isolation boundary. RFC 6265 explicitly notes
that cookies for a host are shared across all of its ports and advises against
placing mutually distrusting services on different ports of the same host:
<https://www.rfc-editor.org/rfc/rfc6265.html>. PacketAgent now requires
different hostnames, and production startup requires both exact origins to use
HTTPS.

R5.5 uses this boundary:

- `PACKETAGENT_APP_ORIGIN` is the workbench authority and
  `PACKETAGENT_PREVIEW_ORIGIN` is the generated-code authority. Development
  defaults the latter to `http://127.0.0.2:8484`, a different loopback cookie
  host from `localhost`; production requires explicit different HTTPS hosts.
- The primary host rejects generated preview documents/assets/runtime APIs.
  The preview host exposes only those paths and `preview-session`; it rejects
  health, auth, workbench, vault, Worker, artifact, and all other routes.
- Workbench session and CSRF cookies stay host-only. A preview capability is
  HMAC-bound to version, workspace, app, checkpoint, read/interactive scope,
  issued/expiry times, and the exact parent origin for interactive use.
- The capability is placed after `#`, exchanged by a nonce-bearing bootstrap,
  and removed before generated code loads. HTTP semantics exclude fragments
  from the request target:
  <https://www.rfc-editor.org/rfc/rfc9110.html#name-uri-references>.
- The exchange sets a Secure, HttpOnly, host-only cookie with a single-app
  path, `SameSite=None`, and `Partitioned`. CHIPS ties that cookie to the
  top-level site instead of making it available across unrelated embedding
  sites:
  <https://privacysandbox.google.com/cookies/chips>.
- Shared capabilities default to one hour and permit only `GET`/`HEAD`
  runtime operations. Interactive capabilities default to 15 minutes, require
  `manageWorkspace`, and bind the iframe to its exact authoring origin.
- Query-string capability delivery is rejected. Every preview request
  rechecks the HMAC, expiry, workspace/app/checkpoint binding, and current
  stored record.

Generated documents receive a cryptographically random 144-bit nonce and an
explicit CSP. `default-src 'none'` is narrowed for the required local runtime,
React ESM source, sql.js/WASM, images, styles, fonts, and workers;
`object-src 'none'`, `frame-src 'none'`, `form-action 'self'`, and
scope-specific `frame-ancestors` close the remaining document channels. CSP3
requires unpredictable per-response nonces, defines `connect-src` as the
script connection boundary, and notes that `frame-ancestors` does not inherit
from `default-src`:
<https://www.w3.org/TR/CSP3/>.

Click-to-edit no longer crosses the same-origin DOM boundary. A nonce-bearing
bridge in an interactive preview sends only bounded selector/label/rectangle
messages to the exact parent origin. The parent checks both `event.origin` and
`event.source`, validates the versioned schema and bounds, and treats the
payload as untrusted selection metadata. That follows the HTML Standard's
guidance to verify the expected origin and data format and to avoid wildcard
targets:
<https://html.spec.whatwg.org/multipage/web-messaging.html#security-postmsg>.

The checked-in Caddy and nginx examples expose the two virtual hosts to the
same backend, deny the opposite surface at the proxy, preserve reviewed host
metadata, and avoid query logging in the nginx format. PacketAgent repeats the
route split behind the proxy.

## R5.5 proof

The deterministic coverage proves production configuration refusal, port-only
cookie-isolation refusal, preview/primary route separation, capability
tamper/expiry/workspace/app/checkpoint binding, fragment-only delivery,
app-path cookie attributes, cross-origin session-exchange rejection,
read-scope mutation denial, interactive parent CSP, per-response script
nonces, bridge injection, bounded parent message parsing, and primary-session
non-inheritance.

The uninjected command is:

```bash
npm run verify:preview-isolation
```

It uses temporary SQLite and generated-runtime state against the real Hono app.
It proves the production origin configuration, both host-denial directions,
fragment bootstrap, Secure/HttpOnly/partitioned cookie, absence of the primary
session cookie, read-only `403`, shared `frame-ancestors 'none'`, interactive
exact-parent CSP, bridge presence, and token absence from generated HTML. Its
Chromium phase then uses a real loopback HTTP server and cross-site iframe to
prove the browser exchanges and resends the partitioned cookie, loads the
generated document, delivers the bridge-ready message, and stores no primary
session cookie on the preview host.

The R5.5 closeout passed typecheck, zero-warning lint, formatting, the
production web build, 33/33 web tests, 62/62 focused preview/security tests,
all four cumulative R5 executable verifiers, and the complete 1,617-test API
suite (1,614 passed with three intentional live interoperability skips). The
preview verifier independently passed 30 deterministic assertions plus the
real Chromium exchange/iframe proof.

## Remaining R5 order

Resume only from the unchecked R5 items in `BACKLOG.md`:

1. R5.6: close the container-hardening matrix and the complete R5 gate.
