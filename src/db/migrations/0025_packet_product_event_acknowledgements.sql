-- W9 PacketADE reconnectable event cursor acknowledgements. SSE delivery is
-- intentionally not durable; these idempotent records are the durable,
-- optimistic cursor-advancement boundary.

create table if not exists packet_product_event_acknowledgements (
  workspace_id text not null,
  id text not null,
  credential_id text not null,
  package_deployment_id text not null,
  worker_deployment_id text not null,
  stream_kind text not null check (stream_kind in ('deployment', 'run')),
  worker_run_id text,
  idempotency_key text not null,
  request_digest text not null,
  event_id text not null,
  workspace_sequence integer not null check (workspace_sequence > 0),
  effective_event_id text not null,
  effective_workspace_sequence integer not null check (effective_workspace_sequence > 0),
  expected_revision integer not null check (expected_revision >= 0),
  disposition text not null check (disposition in ('advanced', 'unchanged')),
  applied_revision integer not null check (applied_revision >= 0),
  acknowledged_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, credential_id)
    references packet_product_credentials (workspace_id, id) on delete restrict,
  foreign key (workspace_id, package_deployment_id)
    references worker_package_deployments (workspace_id, id) on delete restrict,
  foreign key (workspace_id, worker_deployment_id)
    references worker_deployments (workspace_id, id) on delete restrict,
  foreign key (workspace_id, worker_run_id)
    references worker_runs (workspace_id, id) on delete restrict,
  check (
    (stream_kind = 'run' and worker_run_id is not null)
    or (stream_kind = 'deployment' and worker_run_id is null)
  ),
  check (effective_workspace_sequence >= workspace_sequence)
);

create index if not exists idx_packet_product_event_acknowledgements_cursor
  on packet_product_event_acknowledgements (
    workspace_id, credential_id, worker_deployment_id,
    stream_kind, worker_run_id, applied_revision, acknowledged_at, id
  );
