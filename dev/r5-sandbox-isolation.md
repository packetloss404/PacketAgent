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

## Remaining R5 order

Resume only from the unchecked R5 items in `BACKLOG.md`:

1. R5.4: reuse the W6 hardened network port for any declared sandbox egress,
   including redirects, all A/AAAA answers, alternate IP forms, and DNS
   rebinding.
2. R5.5: move generated previews to an isolated origin and narrow cookies, CSP,
   messaging, and proxy rules.
3. R5.6: close the container-hardening matrix and the complete R5 gate.
