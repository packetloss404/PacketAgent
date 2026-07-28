-- W8 Worker event/evidence envelope. Existing v1 event rows remain valid with
-- nullable v2 columns; all new v2 rows populate them in the JSON payload and
-- indexed columns.

alter table worker_events add column source text;
alter table worker_events add column worker_run_id text;
alter table worker_events add column deployment_sequence integer;
alter table worker_events add column run_sequence integer;
alter table worker_events add column evidence_id text;
alter table worker_events add column event_digest text;

create unique index if not exists idx_worker_events_deployment_stream
  on worker_events (workspace_id, worker_deployment_id, deployment_sequence)
  where worker_deployment_id is not null and deployment_sequence is not null;

create unique index if not exists idx_worker_events_run_stream
  on worker_events (workspace_id, worker_run_id, run_sequence)
  where worker_run_id is not null and run_sequence is not null;

create index if not exists idx_worker_events_run_workspace_sequence
  on worker_events (workspace_id, worker_run_id, sequence)
  where worker_run_id is not null;

create table if not exists worker_evidence_entries (
  workspace_id text not null,
  id text not null,
  sequence integer not null check (sequence > 0),
  worker_definition_id text not null,
  worker_version_id text,
  worker_deployment_id text,
  worker_run_id text,
  source_event_id text not null,
  created_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, sequence),
  unique (workspace_id, source_event_id),
  foreign key (workspace_id, source_event_id)
    references worker_events (workspace_id, id) on delete restrict,
  foreign key (workspace_id, worker_run_id)
    references worker_runs (workspace_id, id) on delete restrict
);

create index if not exists idx_worker_evidence_deployment_sequence
  on worker_evidence_entries (workspace_id, worker_deployment_id, sequence);

create index if not exists idx_worker_evidence_run_sequence
  on worker_evidence_entries (workspace_id, worker_run_id, sequence);

create table if not exists worker_artifact_manifests (
  workspace_id text not null,
  id text not null,
  worker_definition_id text not null,
  worker_version_id text not null,
  worker_deployment_id text not null,
  worker_run_id text not null,
  created_at text not null,
  expires_at text,
  manifest_digest text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  foreign key (workspace_id, worker_run_id)
    references worker_runs (workspace_id, id) on delete restrict
);

create index if not exists idx_worker_artifacts_run_created
  on worker_artifact_manifests (workspace_id, worker_run_id, created_at, id);

create index if not exists idx_worker_artifacts_deployment_created
  on worker_artifact_manifests (
    workspace_id, worker_deployment_id, created_at, id
  );
