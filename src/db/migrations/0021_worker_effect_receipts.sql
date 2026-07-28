-- W5 crash-safe Worker side effects. A receipt is prepared before a mutating
-- tool call and completed afterward; uniqueness arbitrates duplicate runners.

create table if not exists worker_effect_receipts (
  workspace_id text not null,
  id text not null,
  worker_run_id text not null,
  worker_version_id text not null,
  worker_deployment_id text not null,
  effect_key text not null,
  iteration integer not null check (iteration >= 0),
  action_id text not null,
  capability_id text not null,
  tool_name text not null,
  operation text not null,
  input_digest text not null,
  classification text not null check (
    classification in (
      'idempotent_mutation',
      'reconcilable_mutation',
      'non_replayable_mutation'
    )
  ),
  status text not null check (status in ('prepared', 'completed')),
  prepared_at text not null,
  completed_at text,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, effect_key),
  unique (workspace_id, worker_run_id, iteration, action_id),
  foreign key (workspace_id, worker_run_id, worker_version_id)
    references worker_runs (workspace_id, id, worker_version_id)
    on delete cascade,
  foreign key (workspace_id, worker_deployment_id)
    references worker_deployments (workspace_id, id)
    on delete restrict
);

create index if not exists idx_worker_effect_receipts_run_status
  on worker_effect_receipts (
    workspace_id, worker_run_id, status, prepared_at, id
  );
