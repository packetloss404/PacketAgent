-- W9 PacketADE-to-PacketAgent trust boundary. Service tokens are represented
-- only by one-way digests. Package receipts preserve the authenticated actor,
-- integrity decision, provenance, and locally narrowed capabilities.

create table if not exists packet_product_credentials (
  workspace_id text not null,
  id text not null,
  product text not null check (product = 'PacketADE'),
  subject_id text not null,
  status text not null check (status in ('active', 'revoked')),
  token_digest text not null,
  require_package_signature integer not null check (require_package_signature in (0, 1)),
  expires_at text,
  created_at text not null,
  updated_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id)
);

create index if not exists idx_packet_product_credentials_subject
  on packet_product_credentials (workspace_id, product, subject_id, status);

create table if not exists worker_package_receipts (
  workspace_id text not null,
  id text not null,
  package_id text not null,
  package_version integer not null check (package_version > 0),
  idempotency_key text not null,
  package_digest text not null,
  request_digest text not null,
  credential_id text not null,
  accepted_at text not null,
  payload text not null check (json_valid(payload)),
  primary key (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, credential_id)
    references packet_product_credentials (workspace_id, id) on delete restrict
);

create index if not exists idx_worker_package_receipts_coordinate
  on worker_package_receipts (
    workspace_id, package_id, package_version, accepted_at, id
  );
