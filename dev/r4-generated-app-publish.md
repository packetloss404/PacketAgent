# R4 generated-app publish research and decisions

Date: 2026-07-29

This note records the active R4 self-host publish contract. `BACKLOG.md`
remains the implementation ledger.

## Research basis

- [RFC 8785, JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
  explains why hash/signature inputs need an invariant JSON representation and
  uses ECMAScript primitive serialization, an I-JSON-compatible value set, no
  inter-token whitespace, and deterministic property sorting. PacketAgent uses
  those relevant constraints in a versioned, product-specific canonicalization
  contract. It does not claim general-purpose RFC 8785 interoperability.
- [Node.js crypto](https://nodejs.org/api/crypto.html) provides the SHA-256,
  HMAC-SHA256, and constant-time equality primitives used by the seal/verify
  boundary. The optional key remains runtime configuration; only a key label
  and MAC are persisted.
- [Vite backend integration](https://vite.dev/guide/backend-integration.html)
  defines the production build manifest's entry, import, dynamic-import, CSS,
  and asset relationships. R4.2 validates the materialized source handoff's
  concrete HTML and CSS references. R4.3 enables Vite's emitted
  `.vite/manifest.json` and validates its files before the standalone runtime
  becomes ready.
- [Dockerfile reference](https://docs.docker.com/reference/dockerfile/) defines
  build-stage network modes, non-root runtime users, and image health checks.
  The Vite compile step uses `RUN --network=none`.
- [Compose services](https://docs.docker.com/reference/compose-file/services/)
  defines the read-only filesystem, capability drop, process/CPU/memory limits,
  health check, restart, and named-volume controls used by the generated
  service.
- [Compose build](https://docs.docker.com/reference/compose-file/build/)
  defines the package-local build context and explicit Dockerfile selection.

## Implemented manifest v2

`packetagent.generated-app-artifact-manifest/v2` is sealed only after exact
artifact bytes are materialized. Its subject includes:

- workspace, generated-app, and immutable checkpoint identity;
- one sorted entry per exported file with relative path, kind, media type,
  byte count, SHA-256, and purpose;
- the entrypoint plus the resolved HTML and CSS local-asset graph and any
  validation issues; and
- `packetagent.generated-app-artifact-manifest-canonical-json/v1` plus the
  SHA-256 algorithm identifier.

The manifest's digest covers that canonical subject. The manifest file does
not list itself because a file checksum that includes its own checksum would
be self-referential; its canonical digest binds the entry list and all other
manifest metadata instead.

When `PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY` is configured, PacketAgent
requires at least 32 bytes and adds an HMAC-SHA256 over the same canonical
subject. `PACKETAGENT_PUBLISH_MANIFEST_SIGNING_KEY_ID` is a non-secret operator
label. The key is neither written to the package nor returned by an API.
Checksums remain mandatory with or without a signature.

## Verification and compatibility

Verification is workspace/app/checkpoint-bound and limited to 1,000 files and
25 MiB. It rejects:

- manifest digest, file size, or file SHA-256 mismatches;
- missing or unexpected files;
- unsafe relative paths and duplicate entries;
- symlinked artifact paths;
- unresolved local HTML or CSS assets;
- a valid manifest substituted from another app or checkpoint; and
- signed manifests whose configured verifier is missing or wrong.

Authenticated workspace viewers can call
`GET /api/app/generated-apps/:appId/publish/integrity`. The endpoint reads and
verifies but never rematerializes the package. Publish preflight uses the same
result, and the Builder Publish tab shows the bounded file/byte totals and
signature status. Legacy list-only manifests remain readable in stored
history, but the v2 verifier labels them unsupported rather than treating
presence as integrity.

## R4.3 verified standalone package

R4.3 is complete. Every new generated-app publish directory contains:

- the generated React/Vite source under `bundle/`;
- `Dockerfile.publish`, `docker-compose.publish.yml`, and `.dockerignore`;
- a dependency-free Node static/health/SQLite server plus the generated
  schema/seed model under `runtime/`;
- checkpoint-bound `runtime-config.json`;
- `RUNBOOK.md`; and
- the v2 manifest sealed over all of those exact source and runtime input
  bytes.

The multi-stage image installs dependencies without lifecycle scripts, copies
the generated source, and runs Vite with build networking disabled. The final
image contains only `dist`, the standalone server, runtime identity, and the
schema model. It runs as the unprivileged `node` user. Compose adds a read-only
root, bounded `/tmp`, a named SQLite volume, all-capability drop,
`no-new-privileges`, PID/CPU/memory limits, and a readiness health check. It
starts one `generated-app` service; PacketAgent and Postgres are not hidden
dependencies.

The emitted Vite `.vite/manifest.json` lives in the image rather than the
source handoff. Runtime startup reads it with a 1 MiB/4,096-reference bound,
requires an entry chunk, and verifies every declared chunk/CSS/asset plus
`index.html` before readiness can pass. The source manifest therefore seals
the declared build inputs while runtime readiness verifies the concrete
build outputs. It does not claim an image digest is part of manifest v2.

`npm run verify:generated-app-publish -- <publish-directory>` uses a unique
Compose project and free loopback port. It runs Compose config, builds and
waits up to a bounded deadline, verifies port mapping, liveness, readiness,
static HTML, list/create/update CRUD, stops and restarts the container, proves
the created record survived in SQLite, archives it, and removes the container,
network, volume, and local verification image. Command output is bounded and
common credential patterns are redacted.

The 2026-07-29 closure run used Docker Engine 29.5.3 and Compose 5.1.4 on
Windows. Both clean and cached builds passed; the cached run completed all 14
steps, including cleanup, in about 21 seconds. The repository closure gate also
passes typecheck, zero-warning lint, formatting, production web build, 32 web
tests, and 1,577 API tests (1,573 passed with four intentional live
interoperability skips).

## R4.4 handoff

The standalone service deliberately exposes a host port on Compose's default
bridge network. R4.4 must add tested reverse-proxy and private-VPN examples,
define trusted-forwarded-header/TLS behavior without weakening direct local
use, and add a bounded reachability command that distinguishes DNS, TCP/TLS,
HTTP health, identity mismatch, and unexpected redirects. Do not claim that
public DNS or TLS is provisioned by PacketAgent.
