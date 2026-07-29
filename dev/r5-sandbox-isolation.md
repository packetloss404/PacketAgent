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

## Remaining R5 order

Resume only from the unchecked R5 items in `BACKLOG.md`:

1. R5.2: inventory `node:vm` and every non-Docker execution route, then define
   supported fail-closed behavior rather than treating a language context as a
   security boundary.
2. R5.3: consolidate and adversarially verify CPU, memory, PID, timeout,
   filesystem, environment, and egress bounds across each supported sandbox
   entry point.
3. R5.4: reuse the W6 hardened network port for any declared sandbox egress,
   including redirects, all A/AAAA answers, alternate IP forms, and DNS
   rebinding.
4. R5.5: move generated previews to an isolated origin and narrow cookies, CSP,
   messaging, and proxy rules.
5. R5.6: close the container-hardening matrix and the complete R5 gate.
