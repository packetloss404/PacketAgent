# R6.5 signed Agent-Worker portability

Status: implemented 2026-07-29. `BACKLOG.md` remains the implementation
ledger. The later R6.6 canonical-only execution and legacy migration gate is
also complete.

## Goal

Move a deeply authored Agent between PacketAgent installations without
exporting secrets, operational history, or install-local identifiers, while
also carrying a deterministic canonical Worker draft that a receiving install
can inspect before the later R6.6 lifecycle migration.

This is intentionally not the PacketADE `WorkerPackage v1` path. That package
has a strict PacketADE source identity, workspace-bound service actor, local
capability receipt, and deployment semantics. A self-host-to-self-host Agent
transfer needs a separate envelope, but it reuses the same canonical Worker
content, digest conventions, and DSSE framing.

## Research basis

- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) defines stable
  canonical JSON bytes for cryptographic hashing and signing by constraining
  input to I-JSON, using ECMAScript primitive serialization, and sorting object
  properties deterministically.
- [Verified RFC 8785 erratum
  7920](https://www.rfc-editor.org/errata/rfc8785) recommends rejecting parsed
  negative zero because canonical serialization otherwise changes `-0` to
  `0`. PacketAgent's shared canonicalizer now rejects it.
- [DSSE](https://github.com/secure-systems-lab/dsse) authenticates the message
  and its type through length-delimited pre-authentication encoding, while
  leaving key management and PKI to the application.
- [The DSSE protocol](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md)
  supplies the exact `DSSEv1` pre-authentication framing used here and by
  `WorkerPackage v1`.
- [Node 22 crypto](https://nodejs.org/docs/latest-v22.x/api/crypto.html)
  provides stable key-object, Ed25519 `sign`, and Ed25519 `verify` primitives.
- [Sigstore bundles](https://docs.sigstore.dev/about/bundle/) demonstrate how a
  portable signature artifact may carry verification material. R6.5 keeps a
  narrower offline SPKI public-key record and fingerprint; transparency-log
  and certificate-chain integration remain optional future trust extensions.

## Frozen v1 contract

`packetagent.agent-worker-bundle/v1` contains four strict sections:

1. `source` records only `PacketAgent` and a canonical export timestamp.
2. `agent` records authored configuration: name, description, instructions,
   provider hint, exact model, route, tools, trigger and schedule, playbook,
   bounded non-secret memory, evaluation expectations, and typed input schema
   with examples.
3. `worker` records the deterministic draft `WorkerVersionContent`, its
   canonical content digest, and the compatibility projection warnings.
4. `integrity` records the canonicalization and digest algorithms, the bundle
   digest, and one Ed25519 DSSE signature with its SPKI DER public key and
   SHA-256 publisher fingerprint.

The canonical digest subject replaces the complete `integrity` section with
only its canonicalization and digest algorithm. The DSSE payload is the exact
canonical subject bytes, not a reserialized or decoded approximation.

Every field list is closed for v1. Unsupported versions, extra fields,
non-canonical timestamps/base64, malformed Worker content, mismatched Worker
projection, changed digests, changed DSSE payload bytes, mismatched public-key
fingerprints, non-Ed25519 keys, and invalid signatures all fail before a write.
Import size is capped at 512 KiB.

## Signing and trust

Production derives a domain-separated Ed25519 seed from the existing
`MASTER_KEY`. The private key never enters the bundle. Development uses a
process-local random Ed25519 identity when no master key exists so unrelated
development installations do not share a known signing key.

The publisher key ID is the full lower-case SHA-256 fingerprint of the SPKI
DER public key:

```text
sha256:<64 hex characters>
```

The receiving installation classifies a valid signature as:

- `local` when the fingerprint is its own signing identity;
- `configured` when the fingerprint is listed in
  `PACKETAGENT_AGENT_BUNDLE_TRUSTED_KEY_IDS`; or
- `untrusted` when the signature is cryptographically valid but the publisher
  is not configured.

An untrusted publisher is not silently accepted. The preflight response shows
the exact fingerprint and the import mutation requires an explicit admin
acknowledgement. Operators can compare and configure fingerprints out of band
for repeat transfers. R6.5 does not claim PKI, transparency-log, or Sigstore
identity verification.

## Deliberate exclusions

The bundle never contains:

- workspace, user, Agent, provider, playbook, or memory IDs;
- provider base URLs, API keys, credential references, encrypted secret
  material, or webhook tokens;
- Agent runs, transcripts, outputs, evidence, costs, publish history, or
  scheduler/job state; or
- an active status or an instruction to deploy the Worker projection.

The provider record is reduced to a non-secret kind/name/default-model hint.
The receiving workspace resolves an exact same-name provider first, then a
single unambiguous provider of that kind. Otherwise it leaves provider setup
for the operator. Custom provider network destinations are never imported.

## Import safety and audit

The API is admin-only:

- `GET /api/app/agents/:agentId/export`
- `POST /api/app/agents/import/validate`
- `POST /api/app/agents/import`

Preflight performs the complete digest/signature/projection verification and
returns provider/tool readiness plus the exact import policy. Import repeats
verification, requires `Idempotency-Key`, and atomically creates both the
Agent and a stable `agent.bundle_imported` audit receipt. Reusing the same key
and bundle returns the first Agent; reusing the key for another valid bundle
conflicts.

Every imported Agent receives new local IDs and lands `paused`, even when the
source Agent was active and carried a schedule. Its Worker content remains a
`draft` projection with `projection.requires_validation`. This prevents an
import from creating model calls, network effects, scheduled work, webhook
authority, or canonical lifecycle deployment.

The workbench exposes an Export control on saved Agents and an Import control
in Projects. Import first shows signature/trust, provider/tool readiness,
paused/draft state, and the fields that are deliberately excluded. The final
button stays disabled until an unconfigured publisher is acknowledged.

## Verification

`npm run verify:agent-portability` is offline and deterministic. It certifies:

- the exact versioned envelope and both SHA-256 digests;
- one valid Ed25519 DSSE signature over exact canonical bytes;
- memory, evaluation, and input-example portability;
- a valid, disabled-trigger canonical Worker draft;
- removal of local IDs, webhook authority, provider destinations, and secret
  fields;
- explicit local versus untrusted publisher classification; and
- fail-closed content tampering.

Focused backend and workbench tests additionally cover strict extra-field
rejection, signer substitution, API headers and RBAC path, preflight, paused
import, fresh IDs, publisher acknowledgement, idempotent replay, changed-input
conflict, and review-dialog gating.

## R6.6 boundary at this checkpoint

R6.5 did not switch Agent runs to the canonical Worker supervisor, validate or
deploy the imported Worker content, or retire the legacy Agent APIs. The later,
completed R6.6 gate characterized compatibility, persisted the migration link,
executed through canonical lifecycle records only, and proved that existing
Agent endpoints and clients retain their promised behavior.
