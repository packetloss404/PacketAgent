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
  concrete HTML and CSS references. R4.3 must enable and validate Vite's
  emitted `.vite/manifest.json` when it turns that source handoff into a
  verified production build.

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

## R4.3 handoff

The current compose export is still inherited guidance and is not yet a
certified generated-app run path. R4.3 must:

1. build the materialized generated app into production assets;
2. enable and validate Vite's `.vite/manifest.json` graph;
3. generate a compose file that starts the intended generated-app runtime,
   rather than merely carrying unused environment hints;
4. run `docker compose config`, start the stack, wait for bounded liveness and
   readiness checks, exercise the generated app, capture a secret-free
   transcript, and stop it; and
5. reseal the final compose/build output bytes in manifest v2.
