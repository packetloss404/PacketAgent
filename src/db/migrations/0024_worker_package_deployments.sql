-- W9 PacketADE-to-PacketAgent deployment bindings. These immutable records
-- prove that every Packet-product deployment/control target came from a
-- previously accepted package receipt.

create table if not exists worker_package_deployments (
  workspace_id text not null,
  id text not null,
  receipt_id text not null,
  package_id text not null,
  package_version integer not null check (package_version > 0),
  package_digest text not null,
  worker_definition_id text not null,
  worker_version_id text not null,
  worker_deployment_id text not null,
  operation text not null check (operation in ('deploy', 'update', 'rollback')),
  created_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, worker_deployment_id),
  foreign key (workspace_id, receipt_id)
    references worker_package_receipts (workspace_id, id) on delete restrict,
  foreign key (workspace_id, worker_definition_id)
    references worker_definitions (workspace_id, id) on delete restrict,
  foreign key (workspace_id, worker_version_id)
    references worker_versions (workspace_id, id) on delete restrict,
  foreign key (workspace_id, worker_deployment_id)
    references worker_deployments (workspace_id, id) on delete restrict
);

create index if not exists idx_worker_package_deployments_package
  on worker_package_deployments (
    workspace_id, package_id, package_version, created_at, id
  );
