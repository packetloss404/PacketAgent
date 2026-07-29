-- Expand the workspace-provider kind constraint to the same six runtime BYOK
-- providers accepted by PacketAgent's vault and provider router. The swap
-- preserves provider ids so existing agent.provider_id references remain valid.

pragma defer_foreign_keys = on;

drop index if exists idx_providers_workspace;

create table if not exists providers_v2 (
  id text primary key,
  workspace_id text not null,
  name text not null,
  kind text not null,
  default_model text not null,
  base_url text null,
  api_key_configured integer not null,
  status text not null,
  created_at text not null,
  updated_at text not null,
  foreign key (workspace_id) references workspaces (id) on delete cascade,
  check (kind in (
    'openai',
    'anthropic',
    'minimax',
    'azure_openai',
    'ollama',
    'gemini',
    'openrouter',
    'custom'
  )),
  check (api_key_configured in (0, 1)),
  check (status in ('connected', 'missing_key', 'disabled'))
);

insert or ignore into providers_v2 (
  id,
  workspace_id,
  name,
  kind,
  default_model,
  base_url,
  api_key_configured,
  status,
  created_at,
  updated_at
)
select
  id,
  workspace_id,
  name,
  kind,
  default_model,
  base_url,
  api_key_configured,
  status,
  created_at,
  updated_at
from providers;

drop table providers;
alter table providers_v2 rename to providers;

create index if not exists idx_providers_workspace on providers (workspace_id, kind, status);
