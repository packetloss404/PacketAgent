-- Canonical Worker persistence. All tables are additive and store the validated
-- versioned record as JSON alongside indexed lifecycle columns.

create table if not exists worker_definitions (
  workspace_id text not null,
  id text not null,
  status text not null check (status in ('draft', 'active', 'retired')),
  name text not null,
  current_version_id text,
  updated_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  foreign key (workspace_id, current_version_id, id)
    references worker_versions (workspace_id, id, worker_definition_id)
    on delete no action deferrable initially deferred
);

create table if not exists worker_versions (
  workspace_id text not null,
  id text not null,
  worker_definition_id text not null,
  version integer not null check (version > 0),
  status text not null check (status in ('draft', 'validated', 'rejected', 'retired')),
  content_digest text not null,
  created_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, worker_definition_id, version),
  unique (workspace_id, id, worker_definition_id),
  foreign key (workspace_id, worker_definition_id)
    references worker_definitions (workspace_id, id) on delete cascade
);

create table if not exists worker_deployments (
  workspace_id text not null,
  id text not null,
  worker_definition_id text not null,
  worker_version_id text not null,
  status text not null check (
    status in (
      'draft', 'validated', 'deployed', 'active', 'paused',
      'attention', 'retired', 'rejected', 'revoked'
    )
  ),
  revision integer not null check (revision > 0),
  updated_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, id, worker_definition_id),
  unique (workspace_id, id, worker_definition_id, worker_version_id),
  foreign key (workspace_id, worker_definition_id)
    references worker_definitions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, worker_version_id, worker_definition_id)
    references worker_versions (workspace_id, id, worker_definition_id)
    on delete restrict
);

create table if not exists worker_runs (
  workspace_id text not null,
  id text not null,
  worker_definition_id text not null,
  worker_version_id text not null,
  worker_deployment_id text not null,
  status text not null check (
    status in (
      'queued', 'running', 'waiting_for_approval', 'paused', 'completed',
      'failed', 'budget_exhausted', 'cancelled', 'quarantined'
    )
  ),
  attempt integer not null check (attempt > 0),
  updated_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, id, worker_version_id),
  foreign key (workspace_id, worker_definition_id)
    references worker_definitions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, worker_version_id, worker_definition_id)
    references worker_versions (workspace_id, id, worker_definition_id)
    on delete restrict,
  foreign key (
    workspace_id, worker_deployment_id, worker_definition_id, worker_version_id
  ) references worker_deployments (
    workspace_id, id, worker_definition_id, worker_version_id
  ) on delete restrict
);

create table if not exists worker_checkpoints (
  workspace_id text not null,
  id text not null,
  worker_run_id text not null,
  worker_version_id text not null,
  sequence integer not null check (sequence >= 0),
  created_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, worker_run_id, sequence),
  foreign key (workspace_id, worker_run_id, worker_version_id)
    references worker_runs (workspace_id, id, worker_version_id)
    on delete cascade
);

create table if not exists worker_deployment_rollouts (
  workspace_id text not null,
  id text not null,
  worker_definition_id text not null,
  from_deployment_id text not null,
  to_deployment_id text not null,
  kind text not null check (kind in ('update', 'rollback')),
  created_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, from_deployment_id, to_deployment_id),
  foreign key (workspace_id, worker_definition_id)
    references worker_definitions (workspace_id, id) on delete cascade,
  foreign key (workspace_id, from_deployment_id, worker_definition_id)
    references worker_deployments (workspace_id, id, worker_definition_id)
    on delete restrict,
  foreign key (workspace_id, to_deployment_id, worker_definition_id)
    references worker_deployments (workspace_id, id, worker_definition_id)
    on delete restrict
);

create table if not exists worker_command_receipts (
  workspace_id text not null,
  id text not null,
  idempotency_key text not null,
  operation text not null check (
    operation in (
      'definition.create', 'version.create', 'version.update_draft',
      'version.validate', 'version.reject', 'deployment.create',
      'deployment.validate', 'deployment.deploy', 'deployment.activate',
      'deployment.pause', 'deployment.resume', 'deployment.retire',
      'deployment.rollback', 'definition.retire'
    )
  ),
  target_id text,
  request_digest text not null,
  created_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, idempotency_key)
);

create table if not exists worker_events (
  workspace_id text not null,
  id text not null,
  sequence integer not null check (sequence > 0),
  type text not null,
  worker_definition_id text not null,
  worker_version_id text,
  worker_deployment_id text,
  occurred_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, sequence),
  foreign key (workspace_id, worker_definition_id)
    references worker_definitions (workspace_id, id) on delete restrict,
  foreign key (workspace_id, worker_version_id, worker_definition_id)
    references worker_versions (workspace_id, id, worker_definition_id)
    on delete restrict,
  foreign key (workspace_id, worker_deployment_id, worker_definition_id)
    references worker_deployments (workspace_id, id, worker_definition_id)
    on delete restrict
);

create index if not exists idx_worker_definitions_workspace_status_updated
  on worker_definitions (workspace_id, status, updated_at desc, id);

create index if not exists idx_worker_versions_definition_version
  on worker_versions (workspace_id, worker_definition_id, version desc);

create index if not exists idx_worker_versions_workspace_digest
  on worker_versions (workspace_id, content_digest);

create index if not exists idx_worker_deployments_definition_status_updated
  on worker_deployments (workspace_id, worker_definition_id, status, updated_at desc, id);

create index if not exists idx_worker_deployments_workspace_status_updated
  on worker_deployments (workspace_id, status, updated_at desc, id);

create unique index if not exists idx_worker_deployments_one_active_definition
  on worker_deployments (workspace_id, worker_definition_id)
  where status = 'active';

create index if not exists idx_worker_runs_deployment_updated
  on worker_runs (workspace_id, worker_deployment_id, updated_at desc, id);

create index if not exists idx_worker_checkpoints_run_sequence
  on worker_checkpoints (workspace_id, worker_run_id, sequence desc);

create index if not exists idx_worker_rollouts_definition_created
  on worker_deployment_rollouts (workspace_id, worker_definition_id, created_at desc, id);

create index if not exists idx_worker_events_definition_sequence
  on worker_events (workspace_id, worker_definition_id, sequence);

create index if not exists idx_worker_events_deployment_sequence
  on worker_events (workspace_id, worker_deployment_id, sequence);
