# PacketADE to PacketAgent handoff

Status: W9 contract and completed handoff-gate record. W9.1-W9.5 are
implemented. W10's PacketChat/PacketPhone routes and local certification are
also complete; only credentialed live interoperability remains conditional.
The exact completed slices are in
[`worker-implementation-loops.md`](worker-implementation-loops.md#w9---packetade-deployment-handoff).

The normative executable v1 contract is
[`src/workers/package/types.ts`](../src/workers/package/types.ts), with strict
validation, canonical bytes, digest verification, and the DSSE verification
seam in [`src/workers/package/validation.ts`](../src/workers/package/validation.ts)
and [`src/workers/package/canonical.ts`](../src/workers/package/canonical.ts).

## Goal

PacketADE can hand durable work to PacketAgent without keeping PacketADE, its terminal, or its original conversation open.

Primary user actions:

- **Deploy to PacketAgent** creates or updates a durable Worker deployment.
- **Keep running** deploys, activates, and follows the Worker while PacketADE remains open.
- **Inspect in PacketAgent** opens the deployment, active run, evidence, and attention state.
- **Pause**, **resume**, and **revoke** operate on the durable deployment rather than a local UI process.

## Research basis

- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) requires invariant
  JSON bytes for reliable hashing and describes recursive property ordering,
  ECMAScript primitive serialization, Unicode constraints, and UTF-8 output.
  WorkerPackage v1 freezes those relevant mechanics in a PacketAgent-owned
  canonicalization identifier instead of claiming general RFC 8785
  conformance.
- [JSON Schema draft
  2020-12](https://json-schema.org/draft/2020-12/json-schema-core.html)
  separates schema identity from validation vocabularies and supports closed
  object shapes. WorkerPackage v1 likewise uses an explicit major version and
  rejects undeclared fields at every package-controlled object boundary.
- [DSSE 1.0.2](https://github.com/secure-systems-lab/dsse/blob/master/protocol.md)
  binds an application-specific payload type to exact serialized bytes through
  pre-authentication encoding. Optional WorkerPackage signatures therefore use
  a standard DSSE JSON envelope rather than a custom signature string.
- [SLSA provenance](https://slsa.dev/spec/v1.2/build-provenance) keeps subjects,
  digests, dependencies, and provenance roles distinct. WorkerPackage artifact
  references similarly carry an opaque reference, media type, byte length,
  content digest, role, and classification while W1 provenance identifies the
  originating PacketADE work.
- [RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html) standardizes bearer
  credentials in the HTTP `Authorization` header, requires TLS, recommends
  audience/scope restriction, and warns against putting tokens in URLs where
  they are commonly logged. PacketAgent accepts the header form only, binds
  every token to one local workspace and operation set, and persists only a
  domain-separated digest.
- [RFC 6585](https://www.rfc-editor.org/rfc/rfc6585.html#section-4) defines
  `429 Too Many Requests` and `Retry-After`. Packet-product writes consume a
  durable per-workspace/per-credential bucket before package or lifecycle
  mutation; W9.3 maps exhausted decisions to that response shape.
- [WHATWG Server-sent events](https://html.spec.whatwg.org/dev/server-sent-events.html)
  defines opaque UTF-8 event IDs and browser `Last-Event-ID` reconnect
  behavior. W9.4 uses the same resume boundary with bounded connections.
- [RFC 9110 conditional requests](https://www.rfc-editor.org/rfc/rfc9110.html)
  defines strong validators, `If-Match`, and `412 Precondition Failed`. W9.4
  uses those semantics to prevent concurrent durable cursor advancement from
  silently overwriting another consumer decision.

## WorkerPackage v1 wire schema

The wire format must be versioned, validated, integrity-protected, and idempotent.

```ts
interface WorkerPackageV1 {
  schemaVersion: "packetagent.worker-package/v1";
  packageId: string;
  packageVersion: number; // positive safe integer
  idempotencyKey: string;
  createdAt: string; // canonical UTC ISO-8601
  createdBy: WorkerActorReference;
  source: WorkerSourceProvenance & {
    product: "PacketADE";
    kind: "packetade";
  };
  worker: {
    name: string;
    description: string;
    content: WorkerVersionContent;
  };
  artifacts: WorkerPackageArtifactReference[];
  integrity: {
    canonicalization: "packetagent.worker-package-canonical-json/v1";
    algorithm: "sha256";
    digest: `sha256:${string}`;
    dsseEnvelope?: {
      payloadType: "application/vnd.packetagent.worker-package.v1+json";
      payload: string; // base64 canonical subject bytes
      signatures: Array<{ keyid?: string; sig: string }>;
    };
  };
}
```

`WorkerVersionContent` is the exact W1 content shape: objective, instructions,
typed input schema, provider route and execution target, verb/resource-scoped
tool capability requests, opaque credential references, triggers, bounded
policy, exit predicates, acceptance commands, and notification route
references. PacketAgent validates that content through the same W1 validator
used before an immutable version can deploy. The package carries no
workspace, definition, version, deployment, or run ID; PacketAgent assigns
those only after W9.2 authenticates and maps the request.

`WorkerPackageArtifactReference` contains `reference`, optional `name`,
`mediaType`, non-negative `byteLength`, `contentDigest`, `role`
(`source | configuration | acceptance | input | other`), and redaction
`classification`. References are unique inside a package.

Secret values are never part of the package. `credentialRefs` name
PacketAgent-side vault entries that the receiving operator is authorized to
resolve. Strict undeclared-field rejection prevents a producer from adding an
inline `apiKey`, token, or alternative execution instruction outside the W1
contract.

## Canonical bytes and integrity

WorkerPackage v1 computes its digest over a `WorkerPackageDigestSubject`:

1. Copy every top-level field except `integrity`.
2. Add `integrity` containing only
   `canonicalization: "packetagent.worker-package-canonical-json/v1"` and
   `algorithm: "sha256"`.
3. Serialize recursively with object property names sorted by UTF-16 code
   units, array order preserved, ECMAScript JSON primitive serialization, no
   whitespace, finite numbers only, no `undefined`, no non-plain objects, and
   no unpaired Unicode surrogates.
4. Encode the canonical string as UTF-8 without a byte-order mark.
5. SHA-256 those bytes and encode lowercase hexadecimal as `sha256:<64 hex>`.

The digest and optional DSSE envelope are excluded from the subject, avoiding
self-reference while binding the canonicalization and digest algorithms.
Digest verification is mandatory for every validation or deployment request.

When a Packet-product trust relationship requires a signature, `payload`
must be base64 of those exact canonical subject bytes. DSSE signs
`PAE(UTF8(payloadType), payloadBytes)`. The receiver first checks schema,
digest, payload type, and byte-for-byte payload equality, then passes each DSSE
signature to the W9.2 trust-policy verifier. An untrusted key hint never
authorizes a package.

Checked compatibility fixtures:

- [`worker-package-v1.valid.json`](../src/workers/package/fixtures/worker-package-v1.valid.json)
  is the canonical accepted v1 example.
- [`worker-package-v2.unsupported.json`](../src/workers/package/fixtures/worker-package-v2.unsupported.json)
  proves unknown major versions fail closed.
- [`packetade-handoff-v1.valid.json`](../src/workers/package/fixtures/packetade-handoff-v1.valid.json)
  supplies the local capability decision, activation input, update, controls,
  and expected events for the disconnect/restart W9.5 gate.

The v1 fixture digest is
`sha256:fcea4fc3eb7cf0598c8d2312b1374bddd1a07c953380bd7a15792e35422e143d`.
Automated contract tests check it after property reordering, validate every W1
field family, reject undeclared fields and missing bounds, detect content
tampering, bind DSSE to the same bytes, and exercise required/untrusted
signature policy.

## Required policy

Every deployment declares:

- maximum elapsed time per run;
- maximum supervisor iterations;
- maximum provider cost or token budget;
- maximum consecutive failures and retry/backoff policy;
- allowed tools with verb/resource scopes;
- network, filesystem, shell, and external-write boundaries;
- an exit predicate;
- what requires approval; and
- where attention and terminal notifications go.

PacketAgent rejects activation if required bounds are absent.

## Lifecycle

```text
draft -> validated -> deployed -> active
                    |            |-> paused -> active
                    |            |-> attention -> active
                    |            |-> retired
                    |-> rejected
```

A deployment points to one immutable Worker version. Updating it creates a new version and an explicit rollout or rollback decision.

## API shape

Initial endpoints:

- `POST /api/worker-packages/validate`
- `POST /api/worker-deployments`
- `PUT /api/worker-deployments/:id`
- `POST /api/worker-deployments/:id/activate`
- `POST /api/worker-deployments/:id/pause`
- `POST /api/worker-deployments/:id/resume`
- `POST /api/worker-deployments/:id/rollback`
- `POST /api/worker-deployments/:id/revoke`
- `GET /api/worker-deployments/:id`
- `GET /api/worker-deployments/:id/runs`
- `GET /api/worker-deployments/:id/events`
- `GET /api/worker-deployments/:id/events/stream`
- `PUT /api/worker-deployments/:id/events/cursor`
- `GET /api/worker-runs/:id/events`
- `GET /api/worker-runs/:id/events/stream`
- `PUT /api/worker-runs/:id/events/cursor`
- `GET /api/worker-events/:eventId/evidence`

Write endpoints require an idempotency key. Package IDs, deployment IDs, and run IDs remain distinct.

### Packet-product request boundary

These routes are service-to-service APIs, not browser-session routes.

- Every request requires `Authorization: Bearer <PacketADE credential>` and
  `PacketAgent-Workspace-Id: <workspace-id>`.
- Every write requires `Idempotency-Key`. For validate, deploy, and update,
  that header must equal the digest-bound `WorkerPackage.idempotencyKey`.
- `POST /api/worker-packages/validate` accepts `workerPackage`,
  `acceptedCapabilityIds`, and optional narrowed `capabilityGrants`. It stores
  the trust receipt but performs no Worker lifecycle write and returns
  `dryRun: true`.
- `POST /api/worker-deployments` accepts the same body and advances the
  accepted package through definition/version validation and deployment.
- `PUT /api/worker-deployments/:id` additionally requires
  `expectedRevision`; it creates an immutable newer WorkerVersion and performs
  one atomic update rollout that retires the prior deployment without
  broadening locally accepted grants.
- Activate, pause, resume, rollback, and revoke bodies require
  `expectedRevision`. Rollback additionally requires `targetPackageVersion`.
  Activate defaults `startRun` to `true`, accepts optional `triggerId` and
  `input`, and admits the manual occurrence through the canonical activation
  inbox. Set `startRun: false` for a trigger-only deployment.
- Run listing accepts the canonical `status`, `cursor`, and `limit` query
  fields.
- Event pages accept an opaque stable `cursor`, `limit`, and
  `from=beginning`. Without either origin, they resume after the authenticated
  credential's durable acknowledgement.
- Event streams use `text/event-stream`, accept `Last-Event-ID`, emit bounded
  heartbeats and an explicit close reason, and never advance durable state.
- Cursor writes require `Idempotency-Key`, a strong `If-Match` event-cursor
  ETag, and `{ "cursor": "<event-id>" }`. They advance monotonically; exact
  retries return the original acknowledgement and stale revisions return
  `412`.
- A cursor whose exact source event has left the retention window returns
  `410` with the minimum retained cursor and workspace sequence.

Responses expose the durable receipt and package/deployment binding,
requested/package-allowed/locally accepted/granted capabilities, local
approval requirements, lifecycle records, and explicit `resultingIds`.
Validation errors include stable `issues[]` entries with JSON/header/query
paths. Authentication failures include `WWW-Authenticate`; rate-limit
responses include `Retry-After`.

## Events returned to PacketADE

PacketAgent emits versioned events:

- `worker.deployed`
- `worker.activated`
- `worker.run.started`
- `worker.run.progress`
- `worker.run.checkpointed`
- `worker.run.approval_required`
- `worker.run.blocked`
- `worker.run.completed`
- `worker.run.failed`
- `worker.run.budget_exhausted`
- `worker.run.cancelled`
- `worker.deployment.paused`
- `worker.deployment.revoked`

Each event includes deployment ID, Worker version, run ID when applicable,
monotonic workspace/deployment/run sequences, timestamp, trace ID (or an
explicit source-trace gap), summary, and an evidence link. Stable event IDs
are opaque stream-bound cursors. Delivery is at least once: consumers
explicitly acknowledge a cursor so reconnecting does not lose events, while an
SSE connection alone is never treated as durable progress. This follows the
WHATWG `Last-Event-ID` reconnect model and RFC 9110 strong conditional-request
semantics.

## Trust boundary

W9.2 implements the receiving side under `src/workers/package/`:

- PacketAgent issues an opaque `pkade.<credential-id>.<secret>` bearer value
  once. Only a domain-separated SHA-256 digest is stored. Credentials are
  fixed to `PacketADE`, one workspace, one `packet_product` actor, explicit
  operations, expiry/revocation state, and whether DSSE verification is
  required.
- Authentication derives the actor from the credential rather than trusting a
  request body. Cross-workspace, expired, revoked, malformed, and
  operation-forbidden requests fail closed.
- `acceptedCapabilityIds` is an explicit local decision and must be a subset
  of the package's default-deny allow list. Optional deployment grants can
  only narrow verbs, resources, or approval requirements further. PacketAgent
  compiles the result against the immutable Worker content digest.
- Successful validation stores
  `packetagent.worker-package-receipt/v1`: package ID/version/digest,
  idempotency/request digest, Worker content digest, PacketADE provenance and
  author, authenticated actor/credential, integrity/signature result, and the
  requested/allowed/accepted/compiled capability decision. This exists before
  any deployment or activation.
- Exact idempotent retries return the original receipt. Reusing the key with a
  different package, credential, or local decision fails, as does rebinding
  one package ID/version to different content.
- A durable per-credential write bucket and workspace activity records cover
  authorized, denied, rate-limited, accepted, rejected, replayed, and
  conflicting writes. Authorization values are never placed in records or
  workspace exports; credential exports omit even the stored digest.

W9.3 calls this boundary for every package/control write and requires the
stored receipt before it invokes W2/W3/W7 lifecycle services. Transport TLS is
an operator/deployment requirement; PacketAgent must not imply that a bearer
token makes plaintext transport safe.

W9.3 implements that rule with immutable
`packetagent.worker-package-deployment/v1` bindings. Each binding joins one
accepted receipt to the resulting Worker definition, immutable version, and
deployment. Inspect/list authenticate through W9.2; lifecycle writes authorize
their exact operation; manual activation uses W3; revoke uses W7. Migration
`0024_worker_package_deployments.sql` persists the binding with referential
constraints, and workspace exports include the secret-free record.

W9.4 implements the deployment/run event pages, bounded SSE routes, evidence
reads, and explicit cursor writes. Migration
`0025_packet_product_event_acknowledgements.sql` persists acknowledgement
identity and revision without coupling retention to source-event foreign keys.

W9.5 closes the local handoff gate with the checked scenario above. The test
aborts a real SSE response, serializes the complete durable store, constructs
new service and route instances, and proves the receipt, active deployment,
queued immutable-version run, acknowledgement, and evidence reconnect before
update, pause/resume, rollback, and revoke. A separate bounded live validation
test runs only when
`PACKETAGENT_PACKETADE_INTEROP_BASE_URL`,
`PACKETAGENT_PACKETADE_INTEROP_TOKEN`, and
`PACKETAGENT_PACKETADE_INTEROP_WORKSPACE_ID` are all explicitly configured.

## Completed delivery order

1. Reconciled and froze the WorkerPackage schema against the completed W1
   Worker domain contract.
2. Implemented validation without activation.
3. Implemented deployment and inspection.
4. Added manual activation with bounded policies.
5. Added event streaming and PacketADE reconnection.
6. Added update, rollback, pause, and revoke.
7. Added PacketChat and PacketPhone notification routes after W7 stabilized.
