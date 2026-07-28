# Worker observability and evidence plan

Last updated: 2026-07-27.

This is the design record for W8. The active implementation ledger remains
[`../BACKLOG.md`](../BACKLOG.md), and executable loop order remains
[`worker-implementation-loops.md`](worker-implementation-loops.md).

## Research basis

The Worker journal is PacketAgent-native. It borrows stable concepts from these
primary specifications without claiming wire-level conformance:

- [CloudEvents 1.0](https://github.com/cloudevents/spec/blob/main/cloudevents/spec.md)
  separates occurrence data from identity, source, type, subject, schema, and
  time context. PacketAgent v2 events keep stable ID, source, type, subject IDs,
  schema version, and occurrence time in the envelope.
- [W3C Trace Context](https://www.w3.org/TR/trace-context/) defines 16-byte
  trace IDs and 8-byte parent/span IDs and rejects all-zero identifiers.
  PacketAgent retains the existing W3C-shaped trace context and now applies the
  all-zero rejection rule to Worker records and evidence.
- [OpenTelemetry event conventions](https://opentelemetry.io/docs/specs/semconv/general/events/)
  treat state changes, checkpoints, and outcomes as named point-in-time events.
  Its messaging conventions recommend propagating message creation context and
  using links when asynchronous work has another active parent. PacketAgent
  keeps trace context plus explicit durable source references rather than
  inventing parentage after a restart.
- [W3C PROV-O](https://www.w3.org/TR/prov-o/) models provenance around entities,
  activities, and responsible agents. [SLSA provenance
  1.1](https://slsa.dev/spec/v1.1/provenance) identifies output subjects by
  digest and records the producing system, resolved inputs, and useful
  byproducts. PacketAgent artifact manifests therefore bind a content
  descriptor to a producer, source evidence, and material descriptors.
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785.html) explains why hashing
  JSON requires invariant serialization. W8 reuses PacketAgent's existing
  deterministic canonical JSON function so Worker digests remain compatible.
  PacketAgent does not claim RFC 8785 conformance until that function passes the
  RFC's complete test corpus.
- [OpenTelemetry's metrics data
  model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/) separates
  event observations from cumulative streams and requires aggregations to have
  well-defined merge semantics. W8.2 therefore uses additive counters and sums
  only for decomposable quantities, retains gauges such as consecutive
  failures with explicit maximum semantics, and treats missing source ranges as
  gaps instead of zeros.
- [OWASP's Logging Cheat
  Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
  requires secrets to stay out of logs, recommends sanitizing event data, and
  treats over-retention as a failure alongside premature deletion.
  [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final)
  defines sanitization by making access to target data infeasible for the
  required protection level. W8.3 therefore removes payload-bearing records
  rather than merely hiding them in the UI, while preserving only digests and
  minimal deletion metadata.

## Contract decisions

### Event envelope

New events use `packetagent.worker-event/v2`. A v2 event contains:

- a workspace-global sequence for reconnectable cursors;
- monotonic deployment and run sequences when those subjects exist;
- definition, immutable version, deployment, and run subjects;
- a bounded source category and concise redacted summary;
- W3C trace context plus explicit activation, job, provider-call, tool-call,
  effect, checkpoint, attention, grant, and control correlation IDs;
- a redaction classification and digest of optional redacted event data; and
- an envelope digest plus the ID of its atomic evidence entry.

Stored `packetagent.worker-event/v1` events remain readable. PacketAgent does
not fabricate evidence or trace fields for historical records.

### Evidence entry

Every new v2 event atomically creates one
`packetagent.worker-evidence/v1` entry. The entry preserves:

- the same workspace sequence and immutable Worker subjects;
- the source event ID and digest;
- durable source references that may outlive their underlying raw records;
- trace correlation, a concise summary, and a redaction classification;
- an optional opaque raw-payload reference with media type, size, digest, and
  expiry, never the raw payload itself;
- optional artifact-manifest IDs; and
- its own content digest.

Source or raw-record retention may create later gaps. The entry's summary,
source IDs, and hashes remain independently useful.

### Artifact manifest

`packetagent.worker-artifact-manifest/v1` records require:

- an opaque artifact reference, media type, byte length, and SHA-256 content
  digest;
- exact Worker version/deployment/run subjects;
- a redaction classification;
- producer kind and ID, source evidence IDs, and input material descriptors;
  and
- a digest over the complete manifest metadata.

An artifact reference alone is not a content digest. Existing tools that only
return a path are not promoted into manifests until the artifact boundary can
read and hash the bytes safely.

### Deterministic rollups

`packetagent.worker-observability-rollup/v1` is a disposable cumulative
projection, not a persisted source of truth. The reducer:

- produces stable version, deployment, and run identities;
- orders every contributing collection before summing or selecting a latest
  record, and never reads the wall clock;
- scopes provider records through journal correlation IDs, Worker jobs through
  their canonical run payload, and activities only through explicit Worker
  IDs;
- does not merge inherited Agent traces or global job-metric snapshots when
  they lack an explicit immutable Worker identity;
- sums calls, costs, tokens, duration, retries, queue samples, approvals,
  checkpoints, budget reservations, artifact bytes, and outcomes while using a
  maximum for current consecutive-failure state; and
- deduplicates unavailable evidence-source references into typed gaps while
  retaining journal-derived counts.

Failed tool results and supervisor phase failures are journal occurrences, so
the projection does not silently discard retries or failed calls. Exit
evaluation counts and matches remain distinct from terminal status.

### Retention and redaction

`packetagent.worker-retention-policy/v1` defines independent metadata, summary,
prompt, tool-payload, and artifact windows. Cleanup:

- is explicitly scoped to one scheduler workspace and bounded by item count
  plus elapsed time;
- uses a truly read-only store path in dry-run mode;
- applies only to terminal-run prompt, checkpoint, output, and effect-result
  bodies so resumable work is never damaged;
- retains duplicate-effect identity, status, timing, and original result
  digest after result-body compaction;
- emits digest-only `worker.retention.*_deleted` event/evidence pairs before
  removing persisted data;
- delegates artifact-byte removal to a port supplied with the opaque reference
  and expected content digest, never generic filesystem deletion; and
- distinguishes retention-explained evidence gaps from unexplained missing
  source records in rollups.

Journal inputs are sanitized before their data and envelope digests are
computed. Observability reads apply a second targeted pass for sensitive keys
and caller-supplied known values. Response digests continue to identify the
stored envelope, not the post-redaction representation.

## Executable W8 loops

### W8.1A - Contract and atomic journal

- Define v2 events, evidence entries, payload references, artifact manifests,
  digest algorithms, validation, and v1 compatibility.
- Append each new event and evidence entry in the same store transaction.
- Persist and export evidence and manifests in JSON, SQLite, and managed
  Postgres modes.

### W8.1B - Source correlation

- Route lifecycle, activation, queue, supervisor, provider, tool, effect,
  approval, checkpoint, control, recovery, and terminal occurrences through the
  journal.
- Carry activation trace context, stable provider-call IDs, tool/effect IDs,
  checkpoint IDs, and approval/control IDs without raw prompts, tool inputs,
  outputs, or secrets.
- Provide ordered, workspace-scoped event, evidence, and artifact repository
  reads for later rollups and APIs.

### W8.1C - Integrity and parity gate

- Reject changed event, evidence, or manifest metadata when its digest no
  longer matches.
- Reject non-monotonic deployment/run streams, invalid or all-zero trace IDs,
  cross-Worker graph drift, and missing v2 event/evidence pairs.
- Verify legacy v1 reads, raw-reference isolation, export isolation, and
  JSON/SQLite/managed-Postgres parity.

### W8.2 - Deterministic rollups

Status: complete.

- Build version/deployment/run rollups exclusively from journal/evidence
  records and durable source adapters.
- Treat absent retained source records as explained gaps, not integrity
  failures.
- Rebuild the same result after process restart and in every storage mode.

### W8.3 - Retention and redaction

Status: complete.

- Add category-specific retention policies and tombstone events.
- Delete raw records or artifact bytes without deleting their durable summary,
  digest, or provenance explanation.
- Bound cleanup jobs by workspace, batch size, time, and dry-run mode.

### W8.4 - API and operator UI

Status: complete.

- Expose cursor-paginated health, attention, event, evidence, artifact, and
  rollup endpoints.
- Add SSE cursor resume and a polling fallback.
- Render one independently authorized Worker operations surface.

Implementation notes:

- The disposable read model validates the canonical store once per request and
  joins identity, rollups, budget, checkpoint, attention, evidence, artifacts,
  and allowed controls on the server.
- Opaque cursors bind the workspace, collection, and normalized filter set.
  SSE additionally accepts `Last-Event-ID`, caps connection duration and event
  count, and closes with an explicit resume sequence.
- `/runs` is the canonical Worker list, `/runs/worker/:id` is its detail view,
  and `/activity` remains the inherited Agent-run surface.

### W8.5 - Answerability gate

Status: active.

- Prove the read model answers what is running, why, from which version and
  checkpoint, at what cost, with what evidence, and what needs attention
  without client-side joins over raw storage.
