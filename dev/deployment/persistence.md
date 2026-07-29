# Persistence

PacketAgent supports three persistence postures. Pick one before your first real deployment; switching later is possible but means a planned migration window.

## Modes

| Mode                 | Set                                                                                                        | Default path                                                    | When to use                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| Local JSON           | `PACKETAGENT_STORE` unset or `json`                                                                        | `data/packetagent.json`                                         | Local development, demos, evaluation. Not for production.            |
| SQLite (single-node) | `PACKETAGENT_STORE=sqlite`                                                                                 | `data/packetagent.sqlite` (override with `PACKETAGENT_DB_PATH`) | One PacketAgent process on one host with a durable local disk.       |
| Managed Postgres     | Managed URL plus `PACKETAGENT_MANAGED_DATABASE_ADAPTER=postgres`; `PACKETAGENT_STORE=postgres` is optional | n/a                                                             | Multiple app processes sharing one correctness-first document store. |

JSON mode is contributor-friendly: a single file you can read and edit by hand. It is not a production posture. Mutations are serialized only inside one process, so multiple processes can lose updates or damage the file.

SQLite mode is the lowest-coordination supported production posture. One Node process, one local SQLite file on a local disk. The runtime applies migrations and sets `busy_timeout=5000`, `journal_mode=wal`, `synchronous=normal`, and `foreign_keys=on`. Whole-store mutations use `BEGIN IMMEDIATE` so a stale in-memory cache cannot overwrite newer committed state. SQLite mode does not coordinate writers across processes - it is single-node by design.

Managed Postgres mode lets multiple PacketAgent app processes share durable
state. The current adapter stores one normalized `PacketAgentData` document row
and serializes mutations with a Postgres transaction, row lock, and advisory
lock. It does not use per-entity Postgres tables. That gives cross-process
correctness, but every mutation rewrites the document and write throughput is
globally serialized. Active-active multi-region writes, PacketAgent-owned
regional failover, and distributed SQLite are not supported.

## Choosing

- One process, one host, low write volume: SQLite.
- Multiple processes or hosts that need to share state at modest write volume: managed Postgres.
- Anything that needs managed backups, PITR, or regional failover: managed Postgres on a provider that owns those guarantees.

A shared SQLite file across multiple containers, VMs, or hosts (NFS, SMB, EFS, Azure Files, sync tooling, or similar) is not supported. WAL and file locking depend on local filesystem semantics; network filesystems silently break those assumptions.

## Environment variables

| Env var                                | Default                   | Notes                                                                                                                                                                   |
| -------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PACKETAGENT_STORE`                    | `json`                    | Set to `sqlite` for SQLite or `postgres` for managed Postgres. A managed URL also selects managed mode unless SQLite is explicit.                                       |
| `PACKETAGENT_DB_PATH`                  | `data/packetagent.sqlite` | SQLite file location when `PACKETAGENT_STORE=sqlite`. Use a path on a local filesystem, not a network mount.                                                            |
| `PACKETAGENT_DATABASE_URL`             | unset                     | Managed Postgres URL. `PACKETAGENT_MANAGED_DATABASE_URL` and `DATABASE_URL` are accepted aliases.                                                                       |
| `PACKETAGENT_MANAGED_DATABASE_ADAPTER` | unset                     | Set to `postgres` for managed startup. The startup guard refuses a managed URL without a recognized adapter.                                                            |
| `MASTER_KEY`                           | _dev key_                 | Vault master passphrase used to derive the AES-256-GCM key for the secrets vault. Set to a deployment-specific secret in production; the dev fallback prints a warning. |

## Backup and restore

For SQLite, PacketAgent ships local operational tooling:

```bash
# Inspect schema status: applied migrations, pending migrations.
npm run db:status

# Snapshot the SQLite file. Checkpoints WAL with `pragma wal_checkpoint(full)` before copy.
npm run db:backup -- --backup-path=data/packetagent.sqlite.bak

# Restore from a backup. Copies to a temp database, applies migrations, validates no pending migrations remain, then swaps in.
npm run db:restore -- --backup-path=data/packetagent.sqlite.bak
```

Stop the app before `db:restore`, `db:reset`, or `db:reset-app` so the database is not replaced under a live process. There are no down migrations; rollback means restoring from a known-good backup taken before the change.

For managed Postgres, use the provider's native backup, point-in-time-restore, retention, encryption, and disaster-recovery controls. Local SQLite tooling is not the right backup mechanism for a managed database.

## Migrations

```bash
# Apply pending migrations to the configured store.
npm run db:migrate

# Recreate the SQLite schema and reseed (destructive).
npm run db:reset
```

Migrations run forward only. New collections that get promoted from `app_records` to dedicated tables (jobs, agent runs, alerts, deliveries, activities, provider calls, activation signals, metric snapshots) ship with backfill commands. Run the dry-run first when restoring an old backup:

```bash
npm run db:backfill-jobs -- --dry-run
npm run db:backfill-jobs

npm run db:verify-jobs
```

Each promoted collection has a matching `db:backfill-<collection>` and `db:verify-<collection>` pair. The backfills are idempotent (`INSERT OR REPLACE` keyed on row id), so re-runs are safe.

For managed Postgres, the `db:backfill-managed-postgres` and
`db:verify-managed-postgres` commands stage stopped JSON or SQLite content into
the managed document adapter. This is a planned cutover, not continuous
dual-write replication. Source records win for matching identities and
target-only records are preserved.

## Data location

- JSON mode: `data/packetagent.json` plus a few sidecar files under `data/`.
- SQLite mode: `data/packetagent.sqlite` (or the path in `PACKETAGENT_DB_PATH`) plus the WAL/SHM siblings the SQLite engine maintains alongside it.
- Managed Postgres mode: control-plane data lives in the database identified by the configured managed URL. Generated-app per-app SQLite files and explicitly configured file artifacts remain local concerns; there is no SQLite parity sidecar for the managed control-plane store.

For JSON or SQLite deployments, back up the entire `data/` directory together.
The scheduler leader-lock file (`data/scheduler-leader.json` by default) is
recovery-irrelevant runtime state and can be excluded. For managed Postgres,
use provider-native database backup plus a separate artifact/generated-app
data backup policy.

## Single-node vs multi-writer

SQLite permits multiple readers and one writer per database file, and PacketAgent's SQLite runtime is tuned for low-contention local writes. It does not solve any of the following:

- Request routing across several Node processes.
- Queue scheduler leadership across several app instances (use the leader-election gate documented in [operations](./operations.md)).
- Global write ordering across regions.
- Regional failover, replication conflict handling, or multi-region active-active writes.
- Cross-process abuse-prevention coordination (use the distributed rate limiter documented in [security](./security.md)).

Multi-process deployments need managed Postgres plus the optional shared-counter
rate limiter and HTTP scheduler coordinator. The supported posture is one
managed Postgres database with multiple PacketAgent app processes coordinating
through the scheduler leader-election HTTP coordinator. Because control-plane
mutations are whole-document and globally serialized, validate workload
latency and contention before adding writers. Unsupported postures include
distributed SQLite, active-active multi-region writes, and PacketAgent-owned
regional database failover or PITR.

## Storage readiness check

There is no standalone `deployment:check-storage` script. Inspect
`GET /api/app/operations/status` for the `storageTopology` report and use the
Operations UI before deployment. Startup guards reject unsupported managed
database postures before the server begins accepting work.

## When to introduce dedicated relational repositories

In SQLite mode, many inherited app collections still live as `app_records`
rows with JSON payloads and sidecar indexes for query-critical reads. Hot
collections and canonical Worker/package records have already been promoted
to dedicated SQLite tables. Managed Postgres does not consume those tables
today; it remains a whole-document adapter.

Promote a new collection to its own table when:

- It needs high-volume filtering, aggregation, retention, reporting, or pagination that cannot be cleanly served by existing indexes.
- Correctness needs row-level constraints, uniqueness, joins, or transactions across specific domain rows rather than whole-store JSON rewrites.
- A workflow needs independent backfills, partial migrations, or operational repair jobs that should not rewrite unrelated collections.
- Multi-process workers or schedulers need explicit claim/lease semantics in database rows.
- Production observability requires database-native query plans and indexes for a domain area.
- A data set has external consumers or integration contracts that should not depend on JSON payload shape inside `app_records`.

When promoting a SQLite collection, ship a forward migration, a repository
module, an idempotent backfill, a verify command, parity tests across stores,
and updated rollback guidance. A future per-entity managed-Postgres design
requires its own explicit backlog decision and the removal criteria in
[`../persistence-authority.md`](../persistence-authority.md).
