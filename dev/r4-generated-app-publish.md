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
- [Docker volumes](https://docs.docker.com/engine/storage/volumes/#back-up-restore-or-migrate-data-volumes)
  documents explicit volume backup/restore workflows using a temporary
  container and an external backup mount.
- [SQLite write-ahead logging](https://www.sqlite.org/wal.html) documents that
  the last connection performs a final checkpoint and removes the WAL/shm
  companions, which is why generated-app file backup is an offline operation.

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

## R4.4 proxy, VPN, and reachability contract

R4.4 is complete. Compose now binds to `127.0.0.1` by default; operators must
explicitly set `PACKETAGENT_GENERATED_APP_BIND_ADDRESS=0.0.0.0` for direct LAN
exposure. Every sealed package contains:

- a Caddy automatic-HTTPS reverse-proxy example with active readiness checks;
- an nginx TLS example with explicit Host and X-Forwarded headers; and
- current Tailscale Serve instructions for private tailnet HTTPS plus a
  separately labeled public Funnel option.

The examples follow current primary documentation:

- [Docker Compose services](https://docs.docker.com/reference/compose-file/services/)
  warns that omitting a host IP binds all interfaces and can bypass firewall
  rules.
- [Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
  documents upstream health checks and its default X-Forwarded header behavior;
  [Caddy global options](https://caddyserver.com/docs/caddyfile/options)
  documents automatic certificate management and HTTP-to-HTTPS redirects.
- [nginx proxy module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
  documents `proxy_set_header` and `$proxy_add_x_forwarded_for`.
- [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve)
  is tailnet-private, while
  [Tailscale Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel)
  is public and has separate approval/policy implications.

`npm run verify:generated-app-reachability -- <publish-directory> <origin>`
requires an origin root without credentials/query/fragment and requires HTTPS
outside loopback. It performs bounded DNS resolution and TCP or
certificate-validating TLS connection checks; fetches liveness, readiness, and
the app root with redirects disabled and a 64 KiB response cap; requires JSON
and HTML content types; and binds readiness to the package's exact app and
checkpoint. Failures distinguish invalid/insecure URL, DNS, TCP, TLS,
unexpected redirect, HTTP status, response size/shape, and identity
substitution. The Docker certification path invokes the same contract against
the loopback package.

The standalone runtime does not use forwarded headers for access decisions,
identity, or URL generation. The examples send conventional headers for proxy
observability, but no `trust proxy` mode is needed or exposed. TLS terminates at
the operator-managed proxy/VPN. PacketAgent neither provisions nor claims DNS,
certificates, VPN policy, or continuous availability.

The closure gate passes typecheck, zero-warning lint, formatting, production
web build, 32 web tests, 18 focused package/reachability/readiness/history
checks, a real 15-step Docker certification with complete cleanup, and 1,581
API tests (1,577 passed with four intentional live interoperability skips).

## R4.5 schema/data truth

R4.5 selects the honest destructive-change contract; it does not add a partial
additive migrator. `reset-and-reseed` is now one exported policy used by the
preview runtime health response and Builder UI, materialized
`runtime-config.json`, standalone `/health/ready` and `/meta`, publish
readiness, integration guidance, and reachability verification. A reachable
runtime that hides or substitutes the policy fails verification.

The behavior is characterized at both runtime boundaries:

- reopening preview SQLite with the same schema preserves user records;
- a preview schema-signature change clears records and loads the new seed;
- the standalone runtime reports the policy and clears/reseeds after a
  schema-changing process restart; and
- generated source labels `src/db/migrations/0001_initial.sql` as reference
  DDL that the generic runtime does not execute.

Every generated runbook includes an offline backup/restore procedure. It stops
the service so the final SQLite connection checkpoints WAL, uses the
already-built generated-app image as a temporary copy helper with the named
volume and an external backup mount, then restarts and re-verifies. The Docker
certifier proves this contract by backing up the stopped volume, restarting,
archiving the created record, stopping again, restoring the backup, recovering
the pre-delete record, and removing all temporary state. Backups remain
outside the sealed publish directory.

This closes R4 without claiming automatic data-preserving migration. A future
migrator would be a new versioned runtime policy and must preserve data under
its own compatibility and recovery gate.

The final R4 gate passes typecheck, zero-warning lint, formatting, production
web build, 32 web tests, 34 focused backend tests, the publish materialization
route, real 20-step Docker certification, and 1,583 API tests (1,579 passed
with four intentional live interoperability skips).
