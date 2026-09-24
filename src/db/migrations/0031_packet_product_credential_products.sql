-- W10 PacketChat Packet-product identity. Existing PacketADE and PacketBench
-- credentials must keep working, so the credential product check is relaxed to
-- the accepted source identities: PacketADE, PacketBench, PacketChat.
--
-- SQLite cannot drop or alter a CHECK constraint in place, so the table is
-- rebuilt. `packet_product_credentials` is referenced by two child tables with
-- ON DELETE RESTRICT foreign keys:
--   * worker_package_receipts (workspace_id, credential_id)
--   * packet_product_event_acknowledgements (workspace_id, credential_id)
-- Dropping a referenced parent would trip those RESTRICTs, so this migration
-- snapshots and clears the dependent child rows inside the migration
-- transaction, rebuilds the parent, then restores the children in dependency
-- order. The child FOREIGN KEY definitions themselves are left untouched and
-- still reference packet_product_credentials (workspace_id, id).

create table _packet_product_credentials_receipts_backup
  as select * from worker_package_receipts;
create table _packet_product_credentials_deployments_backup
  as select * from worker_package_deployments;
create table _packet_product_credentials_acks_backup
  as select * from packet_product_event_acknowledgements;

delete from packet_product_event_acknowledgements;
delete from worker_package_deployments;
delete from worker_package_receipts;

create table packet_product_credentials_v2 (
  workspace_id text not null,
  id text not null,
  product text not null check (product in ('PacketADE', 'PacketBench', 'PacketChat')),
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

insert into packet_product_credentials_v2 (
  workspace_id, id, product, subject_id, status, token_digest,
  require_package_signature, expires_at, created_at, updated_at, payload
)
select
  workspace_id, id, product, subject_id, status, token_digest,
  require_package_signature, expires_at, created_at, updated_at, payload
from packet_product_credentials;

drop table packet_product_credentials;
alter table packet_product_credentials_v2 rename to packet_product_credentials;

create index if not exists idx_packet_product_credentials_subject
  on packet_product_credentials (workspace_id, product, subject_id, status);

insert into worker_package_receipts
  select * from _packet_product_credentials_receipts_backup;
insert into worker_package_deployments
  select * from _packet_product_credentials_deployments_backup;
insert into packet_product_event_acknowledgements
  select * from _packet_product_credentials_acks_backup;

drop table _packet_product_credentials_receipts_backup;
drop table _packet_product_credentials_deployments_backup;
drop table _packet_product_credentials_acks_backup;
