-- W3 canonical Worker activation intake. Payload bodies that are large or
-- sensitive are encrypted in a separate retention-bounded record; the inbox
-- keeps only the immutable envelope and reference metadata.

create table if not exists worker_activation_payloads (
  workspace_id text not null,
  id text not null,
  reference text not null,
  digest text not null,
  classification text not null check (
    classification in ('large', 'sensitive', 'large_and_sensitive')
  ),
  byte_length integer not null check (byte_length >= 0),
  expires_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, reference)
);

create table if not exists worker_activation_inbox (
  workspace_id text not null,
  id text not null,
  worker_deployment_id text not null,
  worker_version_id text not null,
  trigger_id text not null,
  source text not null check (source in ('manual', 'cron', 'webhook', 'alert', 'queue')),
  delivery_id text not null,
  request_digest text not null,
  disposition text not null check (disposition in ('accepted')),
  worker_run_id text not null,
  execution_job_id text not null,
  first_seen_at text not null,
  last_seen_at text not null,
  duplicate_count integer not null check (duplicate_count >= 0),
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (
    workspace_id, worker_deployment_id, trigger_id, source, delivery_id
  ),
  foreign key (workspace_id, worker_deployment_id)
    references worker_deployments (workspace_id, id) on delete restrict,
  foreign key (workspace_id, worker_version_id)
    references worker_versions (workspace_id, id) on delete restrict,
  foreign key (workspace_id, worker_run_id)
    references worker_runs (workspace_id, id) on delete restrict
);

create index if not exists idx_worker_activation_inbox_run
  on worker_activation_inbox (workspace_id, worker_run_id);

create index if not exists idx_worker_activation_inbox_received
  on worker_activation_inbox (workspace_id, first_seen_at desc, id);

create index if not exists idx_worker_activation_payloads_expiry
  on worker_activation_payloads (workspace_id, expires_at, id);
