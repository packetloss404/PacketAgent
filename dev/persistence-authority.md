# Persistence authority and migration contract

Last updated: 2026-07-29.

This document records the R1 persistence end-state decision for the current
implementation. It describes what is authoritative now; it is not a promise
that PacketAgent already has a per-entity managed-Postgres architecture.
Operational setup remains in
[`deployment/persistence.md`](deployment/persistence.md), and remaining work
belongs only in [`../BACKLOG.md`](../BACKLOG.md).

## Decision

`PacketAgentData` and the `loadStore*` / `mutateStore*` facade remain the
logical application contract for the current backlog. The physical authority
depends on the selected store:

| Mode             | Physical authority                                                                                                              | Coordination boundary                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| JSON             | The complete normalized document in `data/packetagent.json` (or the configured path).                                           | One process-local serialized mutation queue plus atomic same-directory file replacement. Contributor/evaluation use only.           |
| SQLite           | Dedicated relational tables for promoted collections; `app_records`, map rows, and `rate_limit_buckets` for the remaining data. | One `BEGIN IMMEDIATE` transaction loads and persists the complete logical store. Supported for one PacketAgent process on one host. |
| Managed Postgres | One normalized document row keyed by `packetagent:store` in `packetagent_document_store`.                                       | A Postgres transaction, row lock, and transaction-scoped advisory lock serialize whole-document mutations across app processes.     |

The managed adapter does not currently read or write the SQLite migration
tables in `src/db/migrations`, and `src/db/postgres-client.ts` is not the
authority for the managed document-store runtime. Multiple PacketAgent
processes can share the managed document safely, but each mutation is globally
serialized and rewrites that document. This is a correctness posture, not a
high-throughput relational scaling claim.

Generated applications have a separate per-app SQLite runtime under
`src/generated-app-runtime/`. Those databases contain generated-app records;
they are never authority for PacketAgent control-plane, Worker, audit, or
credential state.

## SQLite collection ownership

The following promoted collections are loaded from and persisted to dedicated
SQLite tables inside the canonical store transaction:

- job metric snapshots, alert events, agent runs, jobs, invitation email
  deliveries, activities, provider calls, and activation signals;
- Packet-product credentials, package receipts, package deployments, and
  event acknowledgements; and
- Worker definitions, versions, deployments, runs, checkpoints, effect
  receipts, rollouts, command receipts, events, evidence, artifact manifests,
  activation inbox records, and activation payloads.

All other record collections remain in `app_records`; activation facts,
milestones, and read models use map-shaped `app_records` rows; rate-limit
buckets use their dedicated table.

Some inherited write helpers still perform a post-commit repository upsert for
activities, activation signals, agent runs, invitation-email deliveries, or
provider calls. In SQLite mode the canonical transaction has already persisted
those collections. These helpers are compatibility writes, not a second source
of truth and not a SQLite-to-Postgres migration engine. They must not be
extended to new collections.

## Migration and cutover stages

1. **Legacy default-file compatibility.** Startup may copy a legacy TaskLoom
   default data file to the PacketAgent default location when the PacketAgent
   file does not exist. The legacy source is not deleted or rewritten.
2. **JSON to SQLite.** Seed/backfill tooling normalizes the JSON document into
   SQLite. The SQLite transaction writes each collection to its owned physical
   table or record rows.
3. **Old SQLite record rows to dedicated SQLite tables.** Each promoted
   inherited collection has an idempotent `db:backfill-*` command and a
   matching `db:verify-*` command. Run verification before treating the
   dedicated table as cut over.
4. **JSON or SQLite to managed Postgres.** Run
   `db:backfill-managed-postgres`, then `db:verify-managed-postgres`, during a
   planned maintenance/cutover window. The source wins for matching
   identities; target-only records are preserved. This is a staged copy into
   the managed document adapter, not continuous dual-write replication.

Back up the source before any cutover. Do not run two storage modes as active
co-equal authorities.

## Compatibility-facade decision

Do not remove `src/packetagent-store.ts` or its storage-neutral mutation
contract in R1. It is the current logical transaction boundary used by the
Worker lifecycle and inherited application surfaces.

Removing or materially narrowing that facade requires a future explicit
backlog decision and all of the following evidence:

- every production call path uses an asynchronous storage contract;
- JSON, SQLite, and managed implementations have repository parity for every
  persisted record used by that path;
- the managed adapter has an accepted relational schema, forward migration,
  idempotent backfill, verification, recovery, and backup/restore contract;
- compatibility post-commit writers have been removed or proven to be
  independently rebuildable read models;
- duplicate-effect, optimistic-concurrency, tenant-isolation, retention, and
  export/restore tests pass against the replacement; and
- public APIs and persisted identifiers remain compatible or have an explicit
  versioned migration.

Until those gates exist in `BACKLOG.md`, the current facade and the mode
authorities above are the supported end-state.
