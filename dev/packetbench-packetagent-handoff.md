# PacketBench to PacketAgent handoff

This is the current product-identity supplement to the frozen
[`PacketADE to PacketAgent handoff`](packetade-packetagent-handoff.md). The API,
durability, capability, signature, deployment, event, attention, and evidence
rules in that detailed v1 contract remain authoritative unless this supplement
explicitly says otherwise.

## Current and legacy identities

PacketADE was renamed to PacketBench on 2026-08-26. `WorkerPackage v1` now
accepts exactly two paired source identities:

| Status               | `product`     | `kind`        |
| -------------------- | ------------- | ------------- |
| Current              | `PacketBench` | `packetbench` |
| Legacy compatibility | `PacketADE`   | `packetade`   |

Mixed pairs fail validation. Existing PacketADE packages, receipts, bearer
tokens, event acknowledgements, and internal replay keys remain valid. The
legacy `pkade.*` bearer-token prefix and persisted credential product are v1
protocol compatibility identifiers; they are not current UI branding.

The authenticated contract descriptor at `GET /worker-packages/contract`
returns these identities in `sourceIdentities`. New PacketBench producers must
emit `PacketBench` / `packetbench` in `createdBy` and `source`, while continuing
to use the unchanged `packetagent.worker-package/v1` schema and canonical digest
rules.

## Compatibility fixtures

- Current producer fixture:
  [`packetbench-worker-package-v1.valid.json`](../src/workers/package/fixtures/packetbench-worker-package-v1.valid.json)
- Frozen pre-rename fixture:
  [`worker-package-v1.valid.json`](../src/workers/package/fixtures/worker-package-v1.valid.json)
- Serialized legacy restart gate:
  [`packetade-handoff-v1.valid.json`](../src/workers/package/fixtures/packetade-handoff-v1.valid.json)

PacketAgent tests preserve the legacy fixture digest and run the current
PacketBench fixture through validation, deployment, activation, controls, and
durable receipt persistence.

## Package signing

A Packet-product credential minted with `--require-signature` only accepts
WorkerPackages whose `integrity.dsseEnvelope` carries at least one signature
that verifies against an active signing key registered in the same workspace.
Verification is performed by PacketAgent's store-backed registry on every
validate, deploy, and update; unsigned packages fail with
`package.signature.required`, and envelopes without an accepted signature fail
with `package.signature.untrusted`. Credentials without the requirement still
record the number of verified signatures on the receipt.

How PacketBench signs a sealed package:

1. Compute the canonical subject bytes (the package without
   `integrity.digest` and `integrity.dsseEnvelope`, serialized with
   `packetagent.worker-package-canonical-json/v1`). These are the same bytes
   the `sha256:` digest covers.
2. Build the DSSE pre-authentication encoding
   `PAE(UTF8(payloadType), payload)` with
   `payloadType = application/vnd.packetagent.worker-package.v1+json`:
   `"DSSEv1 " + len(payloadType) + " " + payloadType + " " + len(payload) + " " + payload`.
3. Sign the PAE bytes with an Ed25519 private key (pure Ed25519, no prehash).
4. Emit `integrity.dsseEnvelope = { payloadType, payload: base64(subject bytes),
signatures: [{ keyid, sig: base64(signature) }] }`. Standard or URL-safe
   base64 is accepted; `keyid` must equal the registered keyid.

Key registration is workspace-scoped and public-only. PacketBench generates the
Ed25519 keypair, keeps the private key, and hands the SubjectPublicKeyInfo PEM
to the PacketAgent operator:

```bash
node --import tsx src/db/cli.ts packet-product-signing-key add \
  --workspace <workspace-id> --keyid packetbench:<signer-name> \
  --public-key-file <signer>.pub.pem [--description "<text>"]
node --import tsx src/db/cli.ts packet-product-signing-key list --workspace <workspace-id> [--status active|revoked]
node --import tsx src/db/cli.ts packet-product-signing-key revoke --workspace <workspace-id> --keyid packetbench:<signer-name>
```

Rules the registry enforces:

- Only Ed25519 public keys in SPKI PEM form are accepted; private keys, other
  algorithms, and unparsable input are rejected before anything is stored.
- `keyid` is unique per workspace across all statuses. Rotation means
  registering a new keyid; a revoked keyid can never be re-registered.
- A key registered in workspace A never verifies a package submitted to
  workspace B, even when the signature itself is valid.
- Revoked keys stop verifying immediately. Registration and revocation are
  recorded as `packet_product.signing_key_registered` /
  `packet_product.signing_key_revoked` workspace activities carrying the keyid
  and the SPKI SHA-256 fingerprint only.

The authenticated contract descriptor advertises the algorithm, payload type,
PAE rule, encodings, and the workspace's active `keyid`/fingerprint pairs under
`signing`, so PacketBench can confirm its registration before submitting.

## Product boundary

PacketBench authors and supervises development work. PacketAgent owns the
durable Worker after handoff: immutable versions, bounded execution,
permissions, budgets, checkpoints, effect receipts, evidence, approvals,
reconnectable events, stop, and revocation. Closing PacketBench must not stop
the Worker.

Live cross-process certification still requires a separately hosted
PacketAgent endpoint and a workspace-scoped Packet-product credential. Source
compatibility is covered locally; the configured close/relaunch/reconnect gate
remains an operator-run integration check.
